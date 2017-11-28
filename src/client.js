import {events} from './enum';
import Globals from './globals';
import ActorModel from './actor';
import * as Errors from './errors'

import {Dealer as DealerSocket} from './sockets';

let _private = new WeakMap();

export default class Client extends DealerSocket {
    constructor(data = {}) {
        let {id, options, logger} = data;

        super({id, logger});
        let _scope = {
            server: null,
            pingInterval: null,
            logger: logger || console
        };

        super.setOptions(options);

        _scope.logger.info(`Client ${this.getId()} started`);

        this.onTick(events.SERVER_STOP, this::_serverStopHandler);
        this.onTick(events.OPTIONS_SYNC, this::_serverOptionsSync);

        _private.set(this, _scope);
    }

    getServerActor() {
        return _private.get(this).server;
    }

    setOptions (options, notify = true) {
        super.setOptions(options);
        if(notify) {
            this.tick(events.OPTIONS_SYNC, {actorId: this.getId(), options});
        }
    }

    // ** returns a promise which resolves with server model after server replies to events.CLIENT_CONNECTED
    async connect(serverAddress, timeout) {
        try {
            let _scope = _private.get(this);
            await super.connect(serverAddress, timeout);
            let {actorId, options} = await this.request(events.CLIENT_CONNECTED, {actorId: this.getId(), options: this.getOptions()});
            // ** creating server model and setting it online
            _scope.server = new ActorModel( {id: actorId, options: options, online: true, address: serverAddress});
            this::_startServerPinging();
            return {actorId, options}
        } catch (err) {
            this.emit('error', new Errors.ConnectionError({err, id: this.getId()}));
        }
    }

    async handleReconnecting(fd, serverAddress) {
        try {
            this.setOnline();

            let _scope = _private.get(this);
            let {actorId, options} = await this.request(events.CLIENT_CONNECTED, {actorId: this.getId(), options: this.getOptions()});

            if (!_scope.server) {
                _scope.server = new ActorModel( {id: actorId, options: options, online: true, address: serverAddress});
            }

            _scope.server.setOnline();
            this::_startServerPinging();
        } catch (err) {
            this.emit('error', new Errors.ConnectionError({err, id: this.getId(), state: 'reconnecting'}));
        }
    }

    async disconnect(options) {
        let _scope = _private.get(this);
        try {
            let disconnectData = {actorId: this.getId()};

            if (options) {
                disconnectData.options = options;
            }

            if (this.getServerActor() && this.getServerActor().isOnline()) {
                await this.request(events.CLIENT_STOP, disconnectData);
                _scope.server.setOffline();
            }

            this::_stopServerPinging();

            super.disconnect();
        } catch (err) {
            this.emit('error', new Errors.ConnectionError({err, id: this.getId(), state: 'disconnecting'}));
        }
    }

    serverFailHandler() {
        try {
            let _scope = _private.get(this);

            this::_stopServerPinging();

            if (!_scope.server || !_scope.server.isOnline()) {
                return;
            }

            _scope.server.markFailed();

            this.emit(events.SERVER_FAILURE, _scope.server);
        } catch (err) {
            //handle error
        }
    }

    async request (event, data, timeout) {
        let _scope = _private.get(this);

        // this is first request, and there is no need to check if server online or not
        if (event == events.CLIENT_CONNECTED) {
            return await super.request(event, data, timeout);
        }
        if (!_scope.server || !_scope.server.isOnline()) {
            return Promise.reject('server is Offline');
        }
        return await super.request(event, data, timeout, _scope.server.getId())
    }

    async tick (event, data) {
        let _scope = _private.get(this);
        if (!_scope.server || !_scope.server.isOnline()) {
            return Promise.reject('server is offline');
        }
        await super.tick(event, data, _scope.server.getId())
    }
}

function _startServerPinging(){
    let _scope = _private.get(this);

    if(_scope.pingInterval) {
        clearInterval(_scope.pingInterval);
    }

    let options = this.getOptions();
    let interval = options.CLIENT_PING_INTERVAL || Globals.CLIENT_PING_INTERVAL;

    _scope.pingInterval = setInterval(()=> {
        let pingData = { actor: this.getId(), stamp : Date.now()};
        this.tick(events.CLIENT_PING, pingData);
    } , interval);
}

function _stopServerPinging() {
    let _scope = _private.get(this);

    if(_scope.pingInterval) {
        clearInterval(_scope.pingInterval);
    }
}

function _serverStopHandler() {
    try {
        let _scope = _private.get(this);
        if (!_scope.server) {
            throw new Error('client doesn\'t have server');
        }
        _scope.server.markStopped();
        this.emit(events.SERVER_STOP, _scope.server);
    } catch (err) {
        console.error('error while handling serverStop', err);
    }
}

function _serverOptionsSync({options, actorId}) {
    try {
        let _scope = _private.get(this);
        if (!_scope.server) {
            throw new Error('client doesn\'t have server');
        }
        _scope.server.setOptions(options);
    } catch (err) {
        console.error('error while handling server Options sync:', err);
    }
}