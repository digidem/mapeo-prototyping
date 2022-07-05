import net from 'net'
import { EventEmitter } from 'events'

import Hyperswarm from 'hyperswarm'
import { MdnsDiscovery } from 'mdns-sd-discovery'
import SecretStream from '@hyperswarm/secret-stream'
import z32 from 'z32'

export class Discovery extends EventEmitter {
	#identityKeyPair
	#topics = new Map()
	#sockets = new Map()
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
			this.dht = new Hyperswarm()
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

				const stream = new SecretStream(false, socket)
	
				stream.on('connect', () => {
					const remotePublicKey = stream.remotePublicKey.toString('hex')
					// this.#peers.set(remotePublicKey, peer)
	
					if (remotePublicKey === this.identityPublicKey) {
						return
					}

					this.#sockets.set(remotePublicKey, stream)
					this.emit('connection', stream, {
						identityPublicKey: remotePublicKey,
						discoveryType: 'mdns',
						host: socketAddress.address,
						port: socketAddress.port,
						client: false
					})
				})

				stream.on('close', () => {
					const remotePublicKey = stream.remotePublicKey.toString('hex')
					const peer = this.#peers.get(remotePublicKey)
	
					if (peer) {
						this.emit('connectionClosed', peer)
					}
	
					this.#peers.delete(remotePublicKey)
					this.#sockets.delete(remotePublicKey)
				})
			})
		}

		if (this.dht) {
			this.dht.on('connection', (connection, info) => {
				const publicKey = connection.remotePublicKey.toString('hex')

				this.emit('connection', connection, {
					topics: info.topics,
					host: connection.rawStream.remoteHost,
					port: connection.rawStream.remotePort,
					discoveryType: 'dht',
					identityPublicKey: publicKey,
				})
			})
		}
	}

	_updateStatus (topic, status) {
		topic.updateStatus(status)

		this.emit('status', {
			topic: topic.toString(),
			...topic.status()
		})
	}

	/**
	 * @param {Buffer} topicBuffer
	 */
	async join (topicBuffer) {
		const topic = new Topic({
			topicBuffer,
			mdns: this.mdns ? new MdnsDiscovery() : false,
			dht: this.dht ? this.dht.join(topicBuffer) : false
		})

		this.#topics.set(topic.toString(), topic)
	
		this._updateStatus(topic, {
			mdns: this.mdns ? 'joining' : null,
			dht: this.dht ? 'joining' : null
		})

		const serviceType = {
			name: '_mapeo',
			protocol: '_tcp',
			subtypes: [topic.toString()]
		}

		if (this.mdns) {
			topic.mdns.lookup(serviceType)

			topic.mdns.on('stopAnnouncing', () => {
				this._updateStatus(topic, { mdns: this.mdns ? 'closed' : false })
			})

			topic.mdns.announce(serviceType, {
				port: this.port,
				txt: {
					topic: topic.toString(),
					identity: this.identityPublicKey
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
					this._updateStatus(topic, { mdns: this.mdns ? 'joined' : false })

					return
				}
				console.log('found service', service.host, service.port, service.txt.identity)

				const socket = net.connect({
					host,
					port,
					allowHalfOpen: true,
				})

				const stream = new SecretStream(true, socket, {
					keyPair: this.#identityKeyPair
				})

				stream.on('connect', () => {
					this.emit('connection', stream, {
						discoveryType: 'mdns',
						host,
						port,
						identityPublicKey: txt.identity,
						client: true
					})
				})

				stream.on('closed', () => {
					this.emit('connectionClosed', peer)

					// this.#peers.delete(txt.identity)
					this.#sockets.delete(txt.identity)
				})

				this.#sockets.set(txt.identity, stream)
			})

			topic.mdns.on('serviceDown', (service) => {
				const { txt } = service

				let topic = this.#topics.get(txt.topic)

				if (!topic) {
					return
				}

			})
		}
		
		if (this.dht) {
			await topic.dht.flushed()
		}

		this._updateStatus(topic, { dht: this.dht ? 'joined' : null })
		return topic
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
			topic.mdns.unannounce(topic.toString())
		}
	}

	/**
	 * @param {String} options.address
	 * @param {Number} options.port
	 */
	joinPeer (options) {

	}

	/**
	 * @param {Buffer|String} identityPublicKey
	 */
	leavePeer (identityPublicKey) {

	}

	async _closeServer () {
		return new Promise((resolve) => {
			this.#tcp.close(() => {
				resolve()
			})
		})
	}

	async destroy () {
		if (this.dht) {
			await this.dht.destroy()
		}

		if (this.mdns) {
			await this._closeServer()
		}

		for (const topic of this.#topics.values()) {
			topic.destroy()
		}
	}
}

export class Peer extends EventEmitter {
	constructor (options) {
	}

	addTopic (topic) {

	}

	removeTopic (topic) {

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
