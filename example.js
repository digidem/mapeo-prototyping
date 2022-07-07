// import log from 'why-is-node-running'
import crypto from 'hypercore-crypto'

import { Discovery } from './discovery.js'

const key1 = process.argv[2]
const key2 = process.argv[3]
const key3 = process.argv[4]

const identityKeyPair = crypto.keyPair()
const keyPair1 = crypto.keyPair()
const keyPair2 = crypto.keyPair()
const keyPair3 = crypto.keyPair()

const discover = new Discovery({
	identityKeyPair,
	dht: true
})

if (!key1) {
	console.log(`

node example.js ${keyPair1.publicKey.toString('hex')} ${keyPair2.publicKey.toString('hex')} ${
		keyPair3.publicKey.toString('hex')
	}

	`)
}

await discover.ready()
console.log('identity', identityKeyPair.publicKey.toString('hex').slice(0, 8))

discover.on('status', (status) => {
	// console.log('status', status.topic.slice(0, 8), 'mdns:', status.mdns, 'dht:', status.dht)
})

const topic = await discover.join(key1 ? Buffer.from(key1, 'hex') : keyPair1.publicKey)
const topic2 = await discover.join(key2 ? Buffer.from(key2, 'hex') : keyPair2.publicKey)
const topic3 = await discover.join(key3 ? Buffer.from(key3, 'hex') : keyPair3.publicKey)

discover.on('connection', async (connection, info) => {
	console.log('connection', info.discoveryType, discover.peers.length)
	// const topic = discover.status(keyPair.publicKey)
	// await discover.leave(keyPair.publicKey)
})

// setTimeout(async () => {
// 	await discover.leave(keyPair.publicKey)
// }, 1111);

// setTimeout(async () => {
// 	await discover.leave(keyPair2.publicKey)
// }, 2111);

// setTimeout(async () => {
// 	await discover.leave(keyPair3.publicKey)
// }, 3111);

process.on('SIGINT', async () => {
	console.log('\nexiting...')
	await discover.leave(keyPair1.publicKey)
	await discover.leave(keyPair2.publicKey)
	await discover.leave(keyPair3.publicKey)
	await discover.destroy()
	// log()
})
