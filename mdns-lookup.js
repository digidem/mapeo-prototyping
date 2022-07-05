import { MdnsDiscovery } from 'mdns-sd-discovery'

const serviceType = {
	name: '_mapeo',
	protocol: '_tcp'
}

const mdns = new MdnsDiscovery()

mdns.on('service', (service) => {
	const { host, port, txt } = service
	console.log('mapeo', host, port, txt.topic)
})

mdns.on('serviceDown', (service) => {
	const { host, port, txt } = service
	console.log('mapeo', host, port, txt.topic)
})

mdns.lookup(serviceType)
