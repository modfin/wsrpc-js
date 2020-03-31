function WSRPC(protocol, url, defaultHeaders, disableWebsocket) {
	var ws;
	var connected = false;
	var errCount = 0;

	var wsUrl = (protocol === 'https:' ? 'wss://' : 'ws://') + url;
	var httpUrl = protocol + '//' + url;

	var clearingQueue = false;
	var queue = [];

	var resolvers = {};
	var batches = {};

	var reConnectTimeout = 100;
	var reConnectTimeoutLimit = 1200000;

	function uuidv4() {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
			var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}

	function connect() {
		if (disableWebsocket) {
			resolveConnection(wsrpc);
			return
		}

		ws = new WebSocket(wsUrl);

		ws.onopen = function () {
			resolveConnection(wsrpc);

			connected = true;
			reConnectTimeout = 100;

			checkConnectivity();
			reQueue();
		};
		ws.onclose = function () {
			if (!!connected) {
				connected = false;
				reQueue();
			}

			reConnect();
		};

		ws.onerror = function (err) {
			errCount++;

			switch (ws.readyState) {
				case WebSocket.OPEN:
					console.log("confucious says WTF?");
					break;
				case WebSocket.CONNECTING:
					rejectConnection(err);
					break;
				case WebSocket.CLOSING:
				case WebSocket.CLOSED:
				default:
			}
		};

		ws.onmessage = function (message) {
			var data = JSON.parse(message.data);
			onmessage(data)
		};
	}

	function queuePayload(payload) {
		if (!!payload) {
			var data;
			if (Array.isArray(payload) && payload.length > 1) {
				data = payload.length > 1
					? JSON.stringify(payload)
					: JSON.stringify(payload[0])
			} else {
				data = JSON.stringify(payload)
			}

			if (!!data) {
				queue.push(data);
			}
		}

		startSending();
	}

	function reQueue() {
		var resolversArr = Object.keys(resolvers);
		resolversArr.forEach(function(key) {
			var resolver = resolvers[key];

			queuePayload(resolver.payload);
		});
	}

	function startSending() {
		if (clearingQueue) {
			return;
		}

		clearingQueue = true;
		while(queue.length > 0) {
			var data = queue.shift();

			if (!!ws && connected) {
				ws.send(data);
				continue;
			}

			fetch(httpUrl, {
				method: 'POST',
				body: data,
				headers: data.header
					? data.header
					: defaultHeaders,
			}).then(
				function (res) {
					res.json().then(onmessage, onmessage)
				},
				function (err) {
					typeof err.json === 'function'
						? err.json().then(onmessage, onmessage)
						: onmessage({ error: err, message: 'there was an error, but it could not be parsed as json' })
				}
			)
		}

		clearingQueue = false;
	}

	function onmessage(resp) {
		if (Array.isArray(resp)) {
			resp.forEach(parseMessage);
			return;
		}

		parseMessage(resp);
	}

	function parseMessage(resp) {
		var resolver = resolvers[resp.jobId];
		if (!resolver) {
			return
		}

		switch (resolver.type) {
			case 'call':
				resolveCall(resolver, resp);
				break;
			case 'stream':
				if (connected) {
					resolveStream(resolver, resp);
					return;
				}


				var newPayload = [];
				var batchIds = batches[resolver.batchId];
				batches[resolver.batchId] = [];
				batchIds.forEach(function(id) {
					if (id !== resp.jobId) {
						var r = resolvers[id];
						if (!r || !r.payload) {
							return
						}

						newPayload.push(r.payload);
						batches[resolver.batchId].push(id);

						return;
					}

					if (!!resp.error) {
						if (resp.error.code === 205) {
							delete resolvers[resp.jobId];

							if (!!resolver.finalCallback) {
								resolver.finalCallback(resp)
							}

							return;
						}

						if (!!resolver.catchCallback) {
							resolver.catchCallback(resp.error);
						}
						return;
					}

					var cancel = false;
					if (!!resolver.callback) {
						resolver.callback(resp, function(){cancel = true})
					}

					var p = resolver.payload;
					p.header = resp.header;

					newPayload.push(p);
					batches[resolver.batchId].push(id);
				});

				if (newPayload.length > 0) {
					queuePayload(newPayload);
				}

				break;
			default:
				console.log("invalid resolver type");
				return
		}
	}

	function resolveCall(resolver, resp) {
		delete resolvers[resp.jobId];

		if (!!resp.error) {
			if (!!resolver.catchCallback) {
				resolver.catchCallback(resp)
			}
			resolver.reject(resp);
			return;
		}


		if (resolver.callback) {
			resolver.callback(resp)
		}

		resolver.resolve(resp);
	}

	function resolveStream(resolver, resp) {
		if (!!resp.error) {
			if (resp.error.code === 205) {

				delete resolvers[resp.jobId];

				if (!!resolver.finalCallback) {
					resolver.finalCallback(resp, function(){})
				}

				return;
			}

			if (!!resolver.catchCallback) {
				resolver.catchCallback(resp)
			}

			return
		}

		var cancel = false;
		if (!!resolver.callback) {
			resolver.callback(resp, function(){cancel = true})
		}
	}

	// If we receive too many errors over a short period of time we consider the web socket unstable
	// and switch to long polling
	function checkConnectivity() {
		if (errCount >= 10) {
			ws.close(4000);
		}

		errCount = 0;
		setTimeout(checkConnectivity, 5000);
	}

	function reConnect() {
		if (!!connected) {
			return;
		}

		reConnectTimeout = reConnectTimeout * 2 <= reConnectTimeoutLimit
			? reConnectTimeout * 2
			: reConnectTimeoutLimit;
		setTimeout(connect, reConnectTimeout);
	}

	function newPayload(type, method, params, header) {
		return {
			jsonrpc: "2.0",
			jobId: uuidv4(),
			type: type,
			method: method,
			params: params,
			header: header,
		}
	}

	var attemptedConnection = new Promise(function(resolve, reject) {
		resolveConnection = resolve;
		rejectConnection = reject;
	});
	var resolveConnection;
	var rejectConnection;

	var wsrpc = {
		open: function() {
			return ws.readyState === WebSocket.OPEN || disableWebsocket
		},
		manualReconnect: reConnect,
		// args is assumed to be an object containing
		// 1. Either/Both []{method, params} or method, params. Where params is optional for all methods and calls
		// 2. a callback for successful calls
		// 3. a callback for error handling
		call: function (args) {
			var batchId = uuidv4();

			if (!!args.method) {
				args.calls = args.calls || [];

				args.calls.push({
					method: args.method,
					params: args.params,
					header: args.header,
				})
			}

			var payloads = [];
			var promises = [];
			args.calls.forEach(function (call) {
				var p = new Promise(function (resolve, reject) {
					var payload = newPayload('CALL', call.method, call.params, call.header);
					payloads.push(payload);

					batches[batchId] = batches[batchId] ? batches[batchId] : [];
					batches[batchId].push(payload.jobId);

					resolvers[payload.jobId] = {
						batchId: batchId,
						type: 'call',
						args: args,
						payload: payload,
						resolve: resolve,
						reject: reject,
						callback: args.callback,
						catchCallback: args.catchCallback
					}
				});

				promises.push(p)
			});

			queuePayload(payloads);

			return promises.length > 1 ? promises : promises[0];
		},
		streamrx: function (args) {
			var batchId = uuidv4();

			if (!!args.calls && args.calls.length > 1) {

				batches[args.batchId] = [];
			}
			if (!!args.method) {
				args.calls = args.calls || [];

				args.calls.push({
					header: args.header,
					method: args.method,
					params: args.params,
				})
			}

			var payloads = [];
			args.calls.forEach(function (call) {
				var payload = newPayload('STREAM', call.method, call.params, call.header);
				payloads.push(payload);
				batches[batchId] = batches[batchId] ? batches[batchId] : [];
				batches[batchId].push(payload.jobId);

				resolvers[payload.jobId] = {
					batchId: batchId,
					type: 'stream',
					payload: payload,
					callback: args.callback,
					catchCallback: args.catchCallback,
					finalCallback: args.finalCallback,
				};
			});

			queuePayload(payloads);
		},
	};

	reConnect();

	return attemptedConnection;
}

if (typeof module === "undefined") {
	module = {}
}
module.exports = WSRPC;