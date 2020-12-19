import mc, { Client } from "minecraft-protocol";
import { Vec3 } from "vec3";

import * as util from "./util";

export interface BlonbotConfig {
	host: string;
	port: number;
	username: string;
}

export class Blonbot {
	client: Client;
	username: string;
	host: string;
	port: number;
	constructor({ host, port, username }: BlonbotConfig) {
		this.client = mc.createClient({
			host,
			port,
			username
		});
		this.username = username;
		this.host = host;
		this.port = port;
		// TODO tweak viewDistance for best perf
		// this.client.write("settings", {
		// 	locale: "en_us",
		// 	viewDistance: 2,
		// 	chatFlags: 0,
		// 	chatColors: true,
		// 	skinParts: 127,
		// 	mainHand: 1
		// });

		this.client.on("position", ({ teleportId }) => {
			this.client.write("teleport_confirm", { teleportId });
		});
	}

	recv(packetName: string) {
		return new Promise(r => {
			this.client.on(packetName, r);
		});
	}

	activateBlock(location: Vec3) {
		this.client.write("block_place", {
			location,
			direction: 1,
			hand: 0,
			cursorX: 0.5,
			cursorY: 0.5,
			cursorZ: 0.5,
			insideBlock: false
		});
	}

	waitForBlockChange(location: Vec3, ms: number) {
		const blockChange = new Promise(r => {
			this.recv("block_change").then((packet: any) => {
				const { x, y, z } = packet.location;
				if (new Vec3(x, y, z).equals(location)) r(packet);
			});
		});
		return Promise.race([blockChange, util.timeout(ms)]);
	}
}
