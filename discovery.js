import net from 'net'
import { EventEmitter } from 'events'

import Hyperswarm from 'hyperswarm'
import { MdnsDiscovery } from 'mdns-sd-discovery'
import SecretStream from '@hyperswarm/secret-stream'
import z32 from 'z32'

export class Discovery extends EventEmitter {
	#identityKeyPair
	#topics = new Map()
	#peers = new Map()
	#tcp

	constructor (options) {
		super()

		const {
			identityKeyPair,
			dht = true,
			mdns = true
		} = options

		this.#identityKeyPair = identityKeyPair

		if (mdns) {
			this.#tcp = net.createServer()
			this.mdns = mdns
		}
	
		if (dht) {
			this.dht = new Hyperswarm({ keyPair: identityKeyPair, server: false, client: true })
		}
	}

	get identityPublicKey () {
		return this.#identityKeyPair.publicKey.toString('hex')
	}

	get topics () {
		return Array.from(
			this.#topics.values()
		)
	}

	get peers () {
		return Array.from(
			this.#peers.values()
		)
	}

	encodeTopic (key) {
		return z32.encode(key)
	}

	decodeTopic (key) {
		return z32.decode(key)
	}

	async ready () {
		if (this.mdns) {
			await this.#tcp.listen()
			const address = this.#tcp.address()
			this.port = address.port
			this.host = address.address

			this.#tcp.on('connection', (socket) => {
				const socketAddress = /** @type {import('net').AddressInfo} */ (
					socket.address()
				)

				const connection = new SecretStream(false, socket)
	
				connection.on('connect', () => {
					const remotePublicKey = connection.remotePublicKey.toString('hex')

					if (remotePublicKey === this.identityPublicKey) {
						return
					}

					let peer = this.#peers.get(remotePublicKey)

					if (peer) {
						connection.destroy()
					} else {
						peer = new Peer({
							topics: [],
							identityPublicKey: remotePublicKey,
							discoveryType: 'mdns',
							host: socketAddress.address,
							port: socketAddress.port,
							connection
						})

						this.#peers.set(remotePublicKey, peer)
						this.emit('connection', connection, peer)
					}

					console.info('peers server', this.peers.map((peer) => {
						return {
							identityPublicKey: peer.identityPublicKey.slice(0, 8),
							topics: peer.topics,
							port: peer.port,
							host: peer.host,
							discoveryType: peer.discoveryType
						}
					}), this.port)
				})

				connection.on('close', async () => {
					const remotePublicKey = connection.remotePublicKey.toString('hex')
					const peer = this.#peers.get(remotePublicKey)
	
					if (peer) {
						this.emit('connectionClosed', peer)
						peer.destroy()

						peer.on('close', () => {
							this.#peers.delete(remotePublicKey)
						})
					}
				})
			})
		}

		if (this.dht) {
			this.dht.on('connection', async (connection, info) => {
				const publicKey = connection.remotePublicKey.toString('hex')

				let peer = this.#peers.get(publicKey)

				if (peer) {
					connection.destroy()
				} else {
					peer = new Peer({
						topics: info.topics,
						host: connection.rawStream.remoteHost,
						port: connection.rawStream.remotePort,
						discoveryType: 'dht',
						identityPublicKey: publicKey,
						connection
					})

					this.#peers.set(publicKey, peer)
				}

				info.on('topic', (topic) => {
					peer.addTopic(topic)
				})

				connection.on('close', async () => {
					await peer.destroy()
					peer.on('close', () => {
						this.#peers.delete(remotePublicKey)
					})
				})

				connection.on('error', (error) => {
					if (error.code === 'ECONNRESET') {
						// ignore
					}
					connection.destroy()
				})

				this.emit('connection', connection, peer)

				process.nextTick(async () => {
					for (const topic of this.#topics.values()) {
						await this.dht.flush()
						await topic.dht.refresh({ server: false, client: true })
					}
				})
			})
		}
	}

	/**
	 * @param {Buffer} topicBuffer
	 * @param {Object} options
	 * @param {Boolean} [options.mdns]
	 * @param {Boolean} [options.dht]
	 */
	async join (topicBuffer, options = {}) {
		const mdnsActivated = options.mdns ? options.mdns : (this.mdns && !!this.mdns)
		const dhtActivated = options.dht ? options.dht : (this.dht && !!this.dht)

		const topic = new Topic({
			topicBuffer,
			mdns: mdnsActivated ? new MdnsDiscovery() : false,
			dht: dhtActivated ? this.dht.join(topicBuffer, { server: true, client: true }) : false
		})

		this.#topics.set(topic.toString(), topic)

		this._updateStatus(topic, {
			mdns: mdnsActivated ? 'joining' : null,
			dht: dhtActivated ? 'joining' : null
		})

		const serviceType = {
			name: '_mapeo',
			protocol: '_tcp',
			subtypes: [topic.toString()]
		}

		if (mdnsActivated) {
			topic.mdns.on('stopAnnouncing', () => {
				this._updateStatus(topic, {
					mdns: 'closed'
				})
			})

			topic.mdns.on('error', (error) => {
				if (typeof error === 'function') {
					// ignore this because why would this happen?
				}
			})

			topic.mdns.on('service', (service) => {
				const { host, port, txt } = service

				let topic = this.#topics.get(txt.topic)

				if (!topic) {
					topic = new Topic({ topicBuffer: txt.topic })
					this.#topics.set(topic.toString(), topic)
				}

				if (txt.identity === this.identityPublicKey) {
					this._updateStatus(topic, {
						mdns: 'joined'
					})

					return
				}

				let connection
				let peer = this.#peers.get(txt.identity)

				if (peer) {
					peer.update({
						host,
						port
					})
					peer.addTopic(topic.toString())
				} else {
					connection = this._connect(host, port)

					peer = new Peer({
						topics: [topic.toString()],
						discoveryType: 'mdns',
						host,
						port,
						identityPublicKey: txt.identity,
						connection
					})
				}

				this.#peers.set(txt.identity, peer)

				console.info('peers initiator', this.peers.map((peer) => {
					return {
						identityPublicKey: peer.identityPublicKey.slice(0, 8),
						topics: peer.topics,
						port: peer.port,
						host: peer.host,
						discoveryType: peer.discoveryType
					}
				}), this.port)

				if (connection) {
					connection.on('connect', () => {
						this.emit('connection', connection, peer)
					})

					connection.on('closed', async () => {
						peer.destroy()
						peer.on('close', () => {
							this.#peers.delete(remotePublicKey)
						})
					})

					connection.on('error', (error) => {
						console.error('mdns tcp connection error', error)
					})
				}
			})

			topic.mdns.on('serviceDown', (service) => {
				const { txt } = service

				let topic = this.#topics.get(txt.topic)

				if (!topic) {
					return
				}

				const peer = this.#peers.get(txt.identity)

				if (peer && peer.topics.length === 1 && peer.topics.includes(txt.topic)) {
					peer.destroy()
					peer.on('close', () => {
						this.#peers.delete(remotePublicKey)
					})
				}
			})

			topic.mdns.announce(serviceType, {
				port: this.port,
				txt: {
					topic: topic.toString(),
					identity: this.identityPublicKey
				}
			})

			topic.mdns.lookup(serviceType)
		}

		if (dhtActivated) {
			this.dht.flush()
			await topic.dht.flushed()
			this._updateStatus(topic, { dht: 'joined' })
		}

		return topic
	}

	getPeersByTopic (topic) {
		return this.peers.filter((peer) => {
			return peer.topics.include(topic)
		})
	}

	_connect (host, port) {
		const stream = net.connect({
			host,
			port,
			allowHalfOpen: true,
		})

		const connection = new SecretStream(true, stream, {
			keyPair: this.#identityKeyPair
		})

		return connection
	}

	/**
	 * @param {Buffer} topicBuffer
	 */
	async leave (topicBuffer) {
		let topic = this.#topics.get(this.encodeTopic(topicBuffer))

		if (!topic) {
			return
		}

		this._updateStatus(topic, {
			mdns: this.mdns ? 'leaving' : null,
			dht: this.dht ? 'leaving' : null
		})

		if (this.dht) {
			await this.dht.leave(topicBuffer)

			this._updateStatus(topic, {
				dht: 'closed'
			})
		}

		if (this.mdns) {
			topic.destroy()
		}
	}

	/**
	 * @param {String} options.host
	 * @param {Number} options.port
	 */
	joinPeer (options) {
		const connection = this._connect(options.host, options.port)
	}

	/**
	 * @param {Buffer|String} identityPublicKey
	 */
	async leavePeer (identityPublicKey) {
		const peer = this.#peers.get(identityPublicKey)
		peer.destroy()
		peer.on('close', () => {
			this.#peers.delete(remotePublicKey)
		})
	}

	async destroy () {
		for (const peer of this.#peers.values()) {
			peer.destroy()
			peer.on('close', () => {
				this.#peers.delete(peer.identityPublicKey)
			})
		}

		this._closeServer()

		if (this.dht) {
			await this.dht.destroy()
		}

		for (const topic of this.#topics.values()) {
			topic.destroy()
		}

	}

	async _closeServer () {
		if (!this.#tcp) {
			return
		}

		return new Promise((resolve) => {
			this.#tcp.close(() => {
				resolve()
			})
		})
	}

	_upsertPeer (identityPublicKey, options) {
		let peer = this.#peers.get(identityPublicKey)
		
		if (peer) {
			peer.update(options)
		} else {
			peer = new Peer(options)
		}

		this.#peers.set(identityPublicKey, peer)
		return peer
	}

	_updateStatus (topic, status) {
		topic.updateStatus(status)

		this.emit('status', {
			topic: topic.toString(),
			...topic.status()
		})
	}
}

export class Peer extends EventEmitter {
	#topics = new Set()

	constructor (options) {
		super()
		const {
			connection,
			topics = [],
			host,
			port,
			discoveryType,
			identityPublicKey
		} = options

		this.addTopics(topics)
		this.connection = connection
		this.host = host
		this.port = port
		this.discoveryType = discoveryType
		this.identityPublicKey = identityPublicKey

		connection.on('close', () => {
			this.emit('close')
		})
	}

	update (options) {
		const {
			connection,
			topics = [],
			host,
			port,
			discoveryType,
			identityPublicKey
		} = options

		if (topics && topics.length) {
			this.addTopics(topics)
		}

		if (connection) {
			this.connection = connection
		}

		if (host) {
			this.host = host
		}

		if (port) {
			this.port = port
		}

		if (discoveryType) {
			this.discoveryType = discoveryType
		}

		if (identityPublicKey) {
			this.identityPublicKey = identityPublicKey
		}
	}

	addTopic (topic) {
		this.#topics.add(topic)
	}

	addTopics (topics) {
		for (const topic of topics) {
			this.#topics.add(topic)
		}
	}

	removeTopic (topic) {
		this.#topics.delete(topic)
	}

	get topics () {
		return Array.from(
			this.#topics.values()
		)
	}

	toJSON() {
		return {
			topics: this.topics,
			identityPublicKey: this.identityPublicKey,
			host: this.host,
			port: this.port
		}
	}

	destroy () {
		this.connection.destroy()
	}
}

export class Topic extends EventEmitter {
	constructor (options) {
		super()

		const {
			topicBuffer,
			dhtStatus = 'closed',
			mdnsStatus = 'closed',
			mdns,
			dht
		} = options

		this.topicBuffer = topicBuffer
		this.topicString = z32.encode(topicBuffer)
		this.mdns = mdns
		this.dht = dht

		/** @type {('closed'|'joining'|'joined'|'leaving'|'deactivated')} */
		this.dhtStatus = dht ? dhtStatus : 'deactivated'

		/** @type {('closed'|'joining'|'joined'|'leaving'|'deactivated')} */
		this.mdnsStatus = mdns ? mdnsStatus : 'deactivated'
	}

	status () {
		return {
			dht: this.dhtStatus,
			mdns: this.mdnsStatus
		}
	}

	updateStatus (status) {
		if (this.dht && status.dht) {
			this.dhtStatus = status.dht
		}

		if (this.mdns && status.mdns) {
			this.mdnsStatus = status.mdns
		}

		this.emit('status', {
			dht: this.dhtStatus,
			mdns: this.mdnsStatus
		})
	}

	toJSON() {
		return {
			server: this.server,
			topic: this.topicString,
			dhtStatus: this.dhtStatus,
			mdnsStatus: this.mdnsStatus
		}
	}

	toString() {
		return this.topicString
	}

	toBuffer() {
		return this.topicBuffer
	}

	destroy () {
		if (this.mdns) {
			this.mdns.destroy()
		}

		if (this.dht) {
			this.dht.destroy()
		}
	}
}
