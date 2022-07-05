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
			identityKeyPair
		} = options

		this.#identityKeyPair = identityKeyPair
		this.#tcp = net.createServer()
		this.mdns = new MdnsDiscovery()
		this.dht = new Hyperswarm()
	}

	get identityPublicKey () {
		return this.#identityKeyPair.publicKey.toString('hex')
	}

	get topics () {
		return Array.from(
			this.#topics.values()
		)
	}

	encodeDiscoveryKey (key) {
		return z32.encode(key)
	}

	decodeDiscoveryKey (key) {
		return z32.decode(key)
	}

	async ready () {
		await this.#tcp.listen()
		const address = this.#tcp.address()
		this.port = address.port

		this.dht.on('connection', (connection, info) => {
			const publicKey = connection.remotePublicKey.toString('hex')

			this.emit('connection', connection, {
        topics: info.topics,
        host: connection.remoteHost,
        port: connection.remotePort,
        discoveryType: 'dht',
        identityPublicKey: publicKey,
      })
		})

		this.#tcp.on('connection', (socket) => {
			const address = /** @type {import('net').AddressInfo} */ (
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
					host: address.address,
					port: address.port,
					client: true
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

	/**
	 * @param {Buffer} topicBuffer
	 */
	async join (topicBuffer, options = {}) {
		const { client = true, server = true } = options
		const topic = new Topic({ topicBuffer })
		this.#topics.set(topic.toString(), topic)

		const serviceType = {
			name: '_mapeo',
			protocol: '_tcp',
			subtypes: [topic.toString()]
		}

		if (server) {
			topic.updateStatus({ mdns: 'joining' })
			this.mdns.announce(serviceType, {
				port: this.port,
				txt: {
					topic: topic.toString(),
					identity: this.identityPublicKey
				}
			})
		}

		if (client) {
			this.mdns.lookup(serviceType)
			this.mdns.on('service', (service) => {
				const { host, port, txt } = service

				let topic = this.#topics.get(txt.topic)

				if (!topic) {
					topic = new Topic({ topicBuffer: txt.topic, server: false })
					this.#topics.set(topic.toString(), topic)
				}

				if (txt.identity === this.identityPublicKey) {
					topic.updateStatus({
						mdns: 'joined'
					})

					return
				}

				const socket = net.connect({
          host,
          port,
          allowHalfOpen: true,
        })

        const stream = new SecretStream(true, socket, {
          keyPair: this.#identityKeyPair,
        })

        stream.on('connect', () => {
          this.emit('connection', stream, {
						discoveryType: 'mdns',
						host,
						port,
						identityPublicKey: txt.identity
					})
        })

        stream.on('closed', () => {
					this.emit('connectionClosed', peer)

          // this.#peers.delete(txt.identity)
          this.#sockets.delete(txt.identity)
        })

        this.#sockets.set(txt.identity, stream)
			})
		}

		const dhtDiscovery = this.dht.join(topicBuffer)

		if (server) {
			await dhtDiscovery.flushed()
		} else {
			await this.dht.flush()
		}

		return topic
	}

	/**
	 * @param {Buffer} topic
	 */
	leave (topic) {

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

	destroy () {

	}
}

export class Topic extends EventEmitter {
	constructor (options) {
		super()

		const {
			topicBuffer,
			server = false,
			dhtStatus = 'closed',
			mdnsStatus = 'closed'
		} = options

		this.server = server
		this.topicBuffer = topicBuffer
		this.topicString = z32.encode(topicBuffer)

		/** @type {('closed'|'joining'|'joined'|'leaving')} */
		this.dhtStatus = dhtStatus

		/** @type {('closed'|'joining'|'joined'|'leaving')} */
		this.mdnsStatus = mdnsStatus
	}

	status () {
		return {
			dht: this.dhtStatus,
			mdns: this.mdnsStatus
		}
	}

	updateStatus (status) {
		if (status.dht) {
			this.dhtStatus = status.dht
		}

		if (status.mdns) {
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
}
