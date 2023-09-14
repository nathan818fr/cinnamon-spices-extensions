const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const {globalLogger: logger} = require('src/logger');
const {ScreenWatcher} = require('src/screen-watcher');
const {callSafely} = require('src/utils');
const {windowSaver} = require('src/window-saver');

class BackToMonitorExtension {
    constructor(meta) {
        this._meta = meta;
    }

    enable() {
        this._windowsSavedStates = new Map();
        this._monitorDisconnectedWindows = new Map();
        this._settings = {
            rememberState: true,
            minimize: true,
        };

        this._settingsDb = new Settings.ExtensionSettings(this._settings, this._meta.uuid);
        this._settingsDb.bind('rememberState', 'rememberState', this._onRememberStateChange);
        this._settingsDb.bind('minimize', 'minimize', this._onMinimizeChange);

        this._screenWatcher = new ScreenWatcher();
        this._screenWatcher.register();

        this._signalManager = new SignalManager.SignalManager(null);
        this._signalManager.connect(this._screenWatcher, 'output-disconnected', this._onOutputDisconnected);
        this._signalManager.connect(this._screenWatcher, 'output-connected', this._onOutputConnected);
        this._signalManager.connect(this._screenWatcher, 'monitor-unloaded', this._onMonitorUnloaded);
        this._signalManager.connect(this._screenWatcher, 'monitor-loaded', this._onMonitorLoaded);
        this._signalManager.connect(global.screen, 'window-removed', this._onWindowRemoved);

        logger.log(
            `Enabled (with settings 'rememberState': ${this._settings.rememberState}, 'minimize': ${this._settings.minimize})`
        );
    }

    disable() {
        if (this._signalManager) {
            this._signalManager.disconnectAllSignals();
            this._signalManager = null;
        }

        if (this._screenWatcher) {
            this._screenWatcher.unregister();
            this._screenWatcher = null;
        }

        if (this._settingsDb) {
            this._settingsDb.finalize();
            this._settingsDb = null;
        }

        logger.log('Disabled');
    }

    _onRememberStateChange = () => {
        if (!this._settings.rememberState) {
            logger.log("The 'rememberState' parameter has been set to false: delete all saved states");
            this._windowsSavedStates.clear();
        } else {
            logger.log("The 'rememberState' parameter has been set to true");
        }
    };

    _onMinimizeChange = () => {
        logger.log(`The 'minimize' parameter has been set to ${this._settings.minimize}`);
    };

    _onOutputDisconnected = (_, {outputName, monitorRect}) => {
        const time = Date.now();

        const disconnectedWindows = new Set();
        this._monitorDisconnectedWindows.set(outputName, disconnectedWindows);

        for (const metaWindow of global.display.list_windows(0)) {
            if (!windowSaver.isInside(metaWindow, monitorRect)) {
                continue;
            }

            if (this._settings.rememberState && windowSaver.allowsMove(metaWindow)) {
                const windowState = callSafely(() => windowSaver.save(metaWindow));
                if (windowState) {
                    // Transform x and y to relative positions
                    windowState.x -= monitorRect.x;
                    windowState.y -= monitorRect.y;

                    // Save
                    let savedStates = this._windowsSavedStates.get(metaWindow);
                    if (!savedStates) {
                        this._windowsSavedStates.set(metaWindow, (savedStates = new Map()));
                    }
                    if (savedStates.has(outputName)) {
                        logger.log(
                            `Don't save '${metaWindow.get_title()}' from ${outputName}: a pending state from this monitor already exists`
                        );
                    } else {
                        logger.log(
                            `Save '${metaWindow.get_title()}' from ${outputName}: ${JSON.stringify(windowState)}`
                        );
                        savedStates.set(outputName, {windowState, time});
                    }
                }
            }

            disconnectedWindows.add(metaWindow);
        }
    };

    _onOutputConnected = (_, {outputName, monitorRect}) => {
        this._monitorDisconnectedWindows.delete(outputName);
    };

    _onMonitorUnloaded = (_, {outputName, monitorRect}) => {
        const disconnectedWindows = this._monitorDisconnectedWindows.get(outputName);
        if (disconnectedWindows) {
            this._monitorDisconnectedWindows.delete(outputName);

            for (const metaWindow of disconnectedWindows) {
                if (this._settings.minimize && metaWindow.can_minimize()) {
                    metaWindow.minimize();
                }
            }
        }
    };

    _onMonitorLoaded = (_, {outputName, monitorRect}) => {
        for (const [metaWindow, savedStates] of this._windowsSavedStates.entries()) {
            let state = savedStates.get(outputName);
            if (state) {
                // Forget this state
                savedStates.delete(outputName);

                // Forget all younger states
                for (const [k, otherState] of savedStates.entries()) {
                    if (otherState.time >= state.time) {
                        savedStates.delete(k);
                    }
                }

                // Transform x and y to absolute positions
                const windowState = state.windowState;
                windowState.x += monitorRect.x;
                windowState.y += monitorRect.y;

                // Restore
                logger.log(`Restore '${metaWindow.get_title()}' to ${outputName}: ${JSON.stringify(windowState)}`);
                callSafely(() => windowSaver.restore(metaWindow, windowState, monitorRect));
            }
        }
    };

    _onWindowRemoved = (_, metaWindow) => {
        // Free saved states memory
        this._windowsSavedStates.delete(metaWindow);
        for (const disconnectedWindows of this._monitorDisconnectedWindows.values()) {
            disconnectedWindows.delete(metaWindow);
        }
    };
}

module.exports = {BackToMonitorExtension};
