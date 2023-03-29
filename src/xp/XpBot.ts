import { Vec3 } from "vec3";

import _ from "lodash";
import { Blonbot, BotConfig } from "../blonbot";
import * as xpUtil from "./util";
import * as util from "../util";
import { performance } from "perf_hooks";

export const ADVANCEMENT_XP = 200; // Cover Me in Debris gives 100 XP; Serious Dedication gives another 100

const GENERATOR_TIMEOUT = 10; // seconds
const CHUTE_SPEED = 20; // m/s
// const G = -20; // m/s/s
// const G = -50; // m/s/s
const G = 0; // m/s/s
const INITIAL_VELOCITY = -20; // m/s
const TERMINAL_VELOCITY = -90.0; // m/s
const FALL_DISTANCE = 24; // meters
const INVENTORY_START_SLOT = 58;

export interface GeneratorConfig {
	relativeContainerLocation: Vec3;
}

export interface CondenserConfig {
	username: string;
	targetAmount: number;
}

class XpBot extends Blonbot {
	constructor(config: BotConfig) {
		super(config);
	}
	async respawn(): Promise<void> {
		if (!this.position) {
			const { x, y, z } = await this.recv("position");
			this.position = new Vec3(x, y, z);
		}
		this.client.write("client_command", { actionId: 0 });
		await this.recv("position");
	}
	async suicide(fall_distance=FALL_DISTANCE): Promise<void> {
		if (!this.position) {
			const { x, y, z } = await this.recv("position");
			this.position = new Vec3(x, y, z);
		}
		const position = this.position.clone();
		const fallStartHeight = position.y;
		const groundHeight = Math.floor(fallStartHeight - fall_distance);
		let fallVelocity = INITIAL_VELOCITY;

		this.positionLook(position, true);

		while (true) {
			position.y += fallVelocity / util.TPS;
			const onGround = position.y < groundHeight;
			position.y = Math.max(groundHeight, position.y);
			this.positionLook(position, onGround);
			if (onGround) break;
			fallVelocity += G / util.TPS;
			await util.sleep(1 / util.TPS);
		}

		// die
		const { health } = await this.recv("update_health");
		if (health !== 0) {
			this.chat(`Error! I didn't die! Health is ${health}.`);
		} else {
			await this.respawn();
		}
	}
}

export class XpCondenser extends XpBot {
	targetAmount: number;
	timingCb: (time: number) => void;
	exiting: boolean;
	constructor(config: BotConfig, condenserConfig: CondenserConfig, timingCb: (time: number) => void) {
		super(config);
		this.condense = this.condense.bind(this);
		this.targetAmount = condenserConfig.targetAmount;
		this.exiting = false;
		this.timingCb = timingCb;
	}
	async condense(): Promise<void> {
		if (!this.position) {
			const { x, y, z } = await this.recv("position");
			this.position = new Vec3(x, y, z);
		}
		
		this.respawn();

		let state = "condensing";
		let experience = 0;
		let initialPosition = this.position.clone();

		this.client.on("experience", ({totalExperience}) => {
			experience = totalExperience;
		});

		this.client.on("update_health", ({health}) => {
			if (health === 0) {
				this.client.write("client_command", { actionId: 0 });
			}
		});

		while (true) {
			if (state === "condensing") {
				if (experience >= this.targetAmount) {
					state = "suiciding";
					const startTime = performance.now() / 1000;
					this.suicide(30).then(() => {
						const endTime = performance.now() / 1000;
						this.timingCb(endTime - startTime);
						state = "condensing";
					});
				}
			}
			await util.sleep(1 / util.TPS);
		}
	}
}

export class XpGenerator extends XpBot {
	relativeContainerLocation: Vec3;
	actionCounter: number;
	constructor(config: BotConfig, generatorConfig: GeneratorConfig) {
		super(config);
		this.actionCounter = 1;
		this.relativeContainerLocation = generatorConfig.relativeContainerLocation;
	}
	async generateOrTimeOut(): Promise<void> {
		let timeout: NodeJS.Timeout;
		const timeoutPromise = new Promise<void>((resolve, reject) => {
			timeout = setTimeout(() => {
				console.log(`Bot ${this.username} timed out. Disconnecting.`);
				this.disconnect();
				resolve();
			}, 1000 * GENERATOR_TIMEOUT);
		});
		return Promise.race([
			timeoutPromise,
			this.generate().then(() => {
				clearTimeout(timeout);
			}),
		]);
	}
	async generate(): Promise<void> {
		if (!this.position) {
			const { x, y, z } = await this.recv("position");
			this.position = new Vec3(x, y + 0.0625, z);
		}

		const initialPosition = this.position.clone();

		// move to the chute
		const chuteLocation = new Vec3(
			this.relativeContainerLocation.x + initialPosition.x,
			initialPosition.y,
			this.relativeContainerLocation.z + initialPosition.z
		);
		const chuteVelocity = new Vec3(
			chuteLocation.x - this.position.x,
			chuteLocation.y - this.position.y,
			chuteLocation.z - this.position.z
		)
			.normalize()
			.scale(CHUTE_SPEED);
		const distanceToChute = this.position.distanceTo(chuteLocation);
		let distanceTraveled = 0;
		const position = this.position.clone();
		while (true) {
			if (distanceTraveled > distanceToChute - CHUTE_SPEED / util.TPS) {
				// don't move too far
				position.x = chuteLocation.x;
				position.y = chuteLocation.y;
				position.z = chuteLocation.z;
				distanceTraveled = distanceToChute;
			} else {
				position.x += chuteVelocity.x / util.TPS;
				position.y += chuteVelocity.y / util.TPS;
				position.z += chuteVelocity.z / util.TPS;
				distanceTraveled += CHUTE_SPEED / util.TPS;
			}
			this.positionLook(position, true);
			if (distanceTraveled >= distanceToChute) break;
			await util.sleep(1 / util.TPS);
		}

		// take the netherite armor out of the container
		const containerLocation = new Vec3(
			Math.floor(initialPosition.x + this.relativeContainerLocation.x),
			Math.floor(initialPosition.y + this.relativeContainerLocation.y),
			Math.floor(initialPosition.z + this.relativeContainerLocation.z)
		);

		// Assume
		const retrieveWindowId = 1;

		// const { windowId: retrieveWindowId } = await this.recv("open_window");

		const windowItemsPromise = this.recv("window_items", (p: any) => p.windowId == retrieveWindowId);
		this.activateBlock(containerLocation);

		const { stateId, items: windowItems } = await windowItemsPromise;

		// take everything out of the container
		let inventorySlot = 62;
		for (const [slot, item] of windowItems.entries()) {
			if (!item.present) continue;
			const p = {
				slot,
				stateId,
				windowId: retrieveWindowId,
				mouseButton: 0, // left click
				mode: 1, // shift
				changedSlots: [{
					location: slot,
					item: { present: false },
				}, {
					location: inventorySlot--,
					item,
				}],
				cursorItem: { present: false },
			}
			this.client.write("window_click", p);
		}

		// Old packet
		// this.client.write("window_click", {
		// 	windowId: retrieveWindowId,
		// 	slot,
		// 	mouseButton: 0,
		// 	action,
		// 	mode: 1,
		// 	item: { present: false },
		// });

		// console.log("done!");

		// wait for XP
		// let totalExperience = 0;
		// while (totalExperience < ADVANCEMENT_XP) {
		// 	totalExperience = (await this.recv("experience")).totalExperience;
		// }
		await this.recv("experience", (p: any) => p.totalExperience >= ADVANCEMENT_XP);

		// put the armor back
		// this.activateBlock(containerLocation);
		// const replaceWindowId = 2;
		// const { windowId: replaceWindowId } = await this.recv("open_window");
		// const replaceActions = _.range(this.containerSlots.length).map((offset) => {
		// 	const action = this.actionCounter++;
		// 	const slot = INVENTORY_START_SLOT + offset;
		// 	this.client.write("window_click", {
		// 		windowId: replaceWindowId,
		// 		slot,
		// 		mouseButton: 0,
		// 		action,
		// 		mode: 1,
		// 		item: { present: false },
		// 	});
		// });

		inventorySlot = 62;
		for (const [slot, item] of windowItems.entries()) {
			if (!item.present) continue;
			const p = {
				stateId,
				slot: inventorySlot,
				windowId: retrieveWindowId,
				mouseButton: 0, // left click
				mode: 1, // shift
				changedSlots: [{
					location: inventorySlot--,
					item: { present: false },
				}, {
					location: slot,
					item,
				}],
				cursorItem: { present: false },
			}
			this.client.write("window_click", p);
		}
		this.client.write("close_window", { retrieveWindowId });
	}
}

