import crypto from 'hypercore-crypto'

import { Discovery } from './discovery.js'

const keyPair = crypto.keyPair()
const discover = new Discovery({
	identityKeyPair: keyPair
})

await discover.ready()
discover.join(keyPair.publicKey)
