// TODO polyfill Promise API

function WSRPC(url, defaultHeaders, disableWebsocket) {
	var ws;
	var connected = false;
	var errCount = 0;

	if (url[0] === '/') {
		url = window.location.host + url
	}
	var wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
	var httpUrl = window.location.protocol + '//' + url;

	var clearingQueue = false;
	var queue = [];

	var taskCounter = 0;
	var resolvers = {};
	var batchCounter = 0;
	var batches = {};

	var reConnectTimeout = 100;
	var reConnectTimeoutLimit = 1200000;

	function connect() {
		if (disableWebsocket) {
			return
		}

		ws = new WebSocket(wsUrl);
		taskCounter = 0;

		ws.onopen = function () {
			connected = true;
			reConnectTimeout = 100;

			reQueue();
			checkConnectivity();
		};
		ws.onclose = function () {
			if (!!connected) {
				connected = false;
				reQueue();
			}

			reConnect();
		};

		// used for debugging
		var states = {
			3: "closed",
			2: "closing",
			1: "open",
			0: "connecting"
		};
		ws.onerror = function () {
			errCount++;

			switch (ws.readyState) {
				case WebSocket.OPEN:
					console.log("confucious says WTF?");
					break;
				case WebSocket.CONNECTING:
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

			function onError(err) {
				console.log("internal err: ", err);
				return undefined;
			}

			fetch(httpUrl, {
				method: 'POST',
				body: data,
				headers: defaultHeaders ? defaultHeaders : undefined,
			}).then(
				function (res) {
					res.json().then(onmessage, onmessage)
				},
				function (err) {
					err.json().then(onmessage, onmessage)
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
		var resolver = resolvers[resp.id];
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
					if (id !== resp.id) {
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
							delete resolvers[resp.id];

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
		delete resolvers[resp.id];

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

				delete resolvers[resp.id];

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
		if (!!connected || disableWebsocket) {
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
			id: ++taskCounter,
			type: type,
			method: method,
			params: params,
			header: header,
		}
	}

	if (!disableWebsocket) {
		reConnect();
	}
	return {
		// args is assumed to be an object containing
		// 1. Either/Both []{method, params} or method, params. Where params is optional for all methods and calls
		// 2. a callback for successful calls
		// 3. a callback for error handling
		call: function (args) {
			var batchId = batchCounter++;

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
					batches[batchId].push(payload.id);

					resolvers[payload.id] = {
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
			var batchId = batchCounter++;

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
				batches[batchId].push(payload.id);

				resolvers[payload.id] = {
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
	}
}