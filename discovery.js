import net from 'net'
import { EventEmitter } from 'events'

import Hyperswarm from 'hyperswarm'
import { MdnsDiscovery } from 'mdns-sd-discovery'
import z32 from 'z32'

export class Discovery extends EventEmitter {
	#topics = new Map()
	#sockets = new Map()
	#peers = new Map()
	#tcp

	constructor (options) {
		super()

		const {
			identityKeyPair
		} = options

		this.identityKeyPair = identityKeyPair
		this.#tcp = net.createServer()
		this.mdns = new MdnsDiscovery()
		this.dht = new Hyperswarm()

		this.dht.on('connection', (connection, info) => {

		})
	}

	get identityPublicKey () {
		return this.identityKeyPair.publicKey
	}

	async ready () {
		await this.#tcp.listen()
		const address = this.#tcp.address()
		this.port = address.port
	}

	/**
	 * @param {Buffer} topicBuffer
	 */
	async join (topicBuffer, options = {}) {
		const { client = true, server = true } = options
		const serviceType = this._createMdnsServiceType(topicBuffer)

		if (server) {
			this.mdns.announce(serviceType, {
				port: this.port,
				txt: {
					identity: this.identityPublicKey.toString('hex')
				}
			})
		}

		if (client) {
			this.mdns.lookup(serviceType)
			this.mdns.on('service', (service) => {
				console.log('service', service)
			})
		}

		const dhtDiscovery = this.dht.join(topicBuffer)
		await dhtDiscovery.flushed()
	}

	/**
	 * @param {Buffer} topic
	 */
	leave (topic) {

	}

	/**
	 * @param {Buffer} options.identityPublicKey
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

	_createMdnsServiceType (topic) {
		const topicString = z32.encode(topic)

		return {
			name: '_mapeo',
			protocol: '_tcp',
			subtypes: [topicString]
		}
	}
}

export class Peer {
	/**
	 * @param {Object} options
	 * @param {Buffer} options.identityPublicKey
	 * @param {String} options.address
	 * @param {Number} options.port
	 */
	constructor (options) {
		const { address, port } = options
		this.address = address
		this.port = port
	}
}
