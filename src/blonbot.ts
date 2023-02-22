import mc, { Client } from "minecraft-protocol";
import { Vec3 } from "vec3";
import Emittery from "emittery";
import { performance } from "perf_hooks";
import pEvent from "p-event";
import _ from "lodash";

import * as util from "./util";

export interface BotConfig {
	host: string;
	port: number;
	username: string;
}

export type Behavior = AsyncIterator<any>;

export abstract class Bot {
	abstract username: string;
	abstract host: string;
	abstract port: number;
	abstract connected: boolean;
	abstract persist: boolean;
	abstract disconnect(): void;
	abstract client: Client;
	abstract startTime: number;
	started: boolean;
	position: Vec3 | null;
	behaviors: Record<string, (...args: any[]) => Behavior>;
	emitter: Emittery;
	behaviorQueue: Behavior[];
	constructor() {
		this.behaviorQueue = [];
		this.emitter = new Emittery();
		this.behaviors = {};
		this.behaviors.teleport = this.teleport;
		this.started = false;
		this.position = null;
	}
	recv(packetName: string): any {
		return pEvent(this.client, packetName)
	}
	chat(message: string): void {
		this.client.write("chat", { message });
	}
	async start(): Promise<void> {
		const emitter = this.emitter.events([
			"interrupt",
			"persist",
			"pushBehavior",
		]);
		if (this.started) return;
		this.started = true;
		while (this.connected && (this.persist || this.behaviorQueue.length)) {
			if (this.behaviorQueue.length) {
				const currentBehavior = this.behaviorQueue[0];
				const next = currentBehavior.next();
				const result = await Promise.race([next, emitter.next()]);
				if (!(await util.isPending(next)) && (await next).done) {
					this.behaviorQueue.shift();
				}
			} else {
				await emitter.next();
			}
		}
		this.disconnect();
	}
	setPersist(persist: boolean): void {
		this.persist = persist;
		this.emitter.emit("persist", persist);
	}
	interrupt(behavior: Behavior): void {
		this.behaviorQueue.unshift(behavior);
		this.emitter.emit("interrupt", behavior);
	}
	pushBehavior(behavior: Behavior): void {
		this.behaviorQueue.push(behavior);
		this.emitter.emit("pushBehavior", behavior);
	}
	async *teleport(
		username: string,
		destinationName: string,
		location: Vec3
	): AsyncIterator<void> {
		let position = this.position;
		if (!position) {
			const { x, y, z } = (await this.recv("position")) as any;
			position = new Vec3(x, y, z);
		}

		const reply = (message: string) =>
			this.chat(`/tell ${username} ${message}`);

		const dist = position.distanceTo(location);
		const reach = 6;
		if (dist > reach) {
			reply(
				`Warning: I am ${dist.toFixed(
					1
				)} blocks away from the trigger. Teleport may fail.`
			);
		}

		this.client.write("block_place", {
			location,
			direction: 1,
			hand: 0,
			cursorX: 0.5,
			cursorY: 0.5,
			cursorZ: 0.5,
			insideBlock: false,
		});

		if (this.username.toLowerCase().includes("mom")) {
			reply(`Have a nice trip, honey!`);
		} else {
			reply(`Initiated teleport to ${destinationName}.`);
		}

		yield await util.sleep(0.8); // wait for pearl to land

		this.client.write("block_place", {
			location,
			direction: 1,
			hand: 0,
			cursorX: 0.5,
			cursorY: 0.5,
			cursorZ: 0.5,
			insideBlock: false,
		});

		yield await util.sleep(1);
	}
}

export class Blonbot extends Bot {
	client: Client;
	username: string;
	host: string;
	port: number;
	connected: boolean;
	persist: boolean;
	startTime: number;
	behaviors: Record<string, (...args: any[]) => Behavior>;
	constructor(config: BotConfig) {
		super();
		this.client = mc.createClient(config);
		this.startTime = performance.now();
		this.connected = true;
		this.username = config.username;
		this.host = config.host;
		this.port = config.port;
		this.persist = false;
		this.behaviors = {};
		// TODO tweak viewDistance for best perf
		// this.client.write("settings", {
		// 	locale: "en_US",
		// 	viewDistance: 4,
		// 	chatFlags: 0,
		// 	chatColors: true,
		// 	skinParts: 127,
		// 	mainHand: 1
		// });

		this.client.on("position", ({ x, y, z, teleportId }) => {
			this.position = new Vec3(x, y, z);
			this.client.write("teleport_confirm", { teleportId });
		});
	}

	positionLook(position: Vec3, onGround: boolean) {
		this.position = position;
		this.client.write("position_look", {
			x: position.x,
			y: position.y,
			z: position.z,
			yaw: 0,
			pitch: 0,
			onGround,
			time: 0,
		});
	}
	disconnect(reason?: string) {
		this.client.end(reason || "");
		this.connected = false;
	}
	activateBlock(location: Vec3): void {
		this.client.write("block_place", {
			location,
			direction: 1,
			hand: 0,
			cursorX: 0.5,
			cursorY: 0.5,
			cursorZ: 0.5,
			insideBlock: false,
		});
	}
}
