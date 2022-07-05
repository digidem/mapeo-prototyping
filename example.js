import crypto from 'hypercore-crypto'

import { Discovery } from './discovery.js'

const key = process.argv[2]

const keyPair = crypto.keyPair()
const discover = new Discovery({
	identityKeyPair: keyPair
})

await discover.ready()
const topic = await discover.join(keyPair.publicKey)

console.log(topic.status())
topic.on('status', (status) => {
	console.log('status', status)
})

discover.on('connection', (connection, info) => {
	console.log('connection', info)
	const topic = discover.status(keyPair.publicKey)
	console.log('topic', topic)
})
