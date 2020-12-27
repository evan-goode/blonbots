import { Vec3 } from "vec3";
import _ from "lodash";
import { v1 as uuidv1 } from "uuid";
import { performance } from "perf_hooks";

import * as util from "./util";
import { Blonbot, BotConfig } from "./blonbot";

export const XP_PER_BOT = 49; // 100 xp from advancement gets to level 7, then drop 7 * level on death
const ORBS_PER_BOT = 5; // empirical testing
const ORB_INGEST_RATE = 10; // player can ingest 1 orb every 2 gt
const ADVANCEMENT_XP = 100; // Cover Me in Debris gives 100 XP

const YEETER_TIMEOUT = 10; // seconds
const CHUTE_SPEED = 8; // m/s
const G = -1.5; // m/s/s
const INITIAL_VELOCITY = -2; // m/s
const TERMINAL_VELOCITY = -40.0; // m/s
const FALL_DISTANCE = 24; // meters

const INVENTORY_START_SLOT = 59;

interface ArmorSet {
	relativeContainerLocation: Vec3;
	relativeChuteLocation: Vec3;
	slots: number[];
}

class Yeeter extends Blonbot {
	actionCounter: number;
	armorSet: ArmorSet;
	constructor(config: BotConfig, armorSet: ArmorSet) {
		super(config);
		this.actionCounter = 1;
		this.armorSet = armorSet;
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
	async yeetOrTimeOut(): Promise<boolean> {
		let timeout: NodeJS.Timeout;
		const timeoutPromise = new Promise<boolean>(r => {
			timeout = setTimeout(() => {
				console.log(`Bot ${this.username} timed out. Disconnecting.`);
				this.disconnect();
				r(false);
			}, 1000 * YEETER_TIMEOUT);
		});
		return Promise.race([
			timeoutPromise,
			this.yeet().then(() => clearTimeout(timeout)).then(() => true),
		]);
	}
	async yeet(): Promise<void> {
		let position = this.position;
		if (!position) {
			const { x, y, z } = await this.recv("position");
			position = new Vec3(x, y, z);
		}

		const containerLocation = new Vec3(
			Math.floor(position.x + this.armorSet.relativeContainerLocation.x),
			Math.floor(position.y + this.armorSet.relativeContainerLocation.y),
			Math.floor(position.z + this.armorSet.relativeContainerLocation.z)
		);

		// take the netherite armor out of the container
		this.activateBlock(containerLocation);
		const { windowId: retrieveWindowId } = await this.recv("open_window");
		const retrieveActions = this.armorSet.slots.map((slot, index) => {
			const action = this.actionCounter++;
			this.client.write("window_click", {
				windowId: retrieveWindowId,
				slot,
				mouseButton: 0,
				action,
				mode: 1,
				item: { present: false },
			});
			return action;
		});
		this.client.write("close_window", { retrieveWindowId });

		// wait for XP
		let totalExperience = 0;
		while (totalExperience < ADVANCEMENT_XP) {
			totalExperience = (await this.recv("experience")).totalExperience;
		}

		// put the armor back
		this.activateBlock(containerLocation);
		const { windowId: replaceWindowId } = await this.recv("open_window");
		const replaceActions = _.range(4).map((offset) => {
			const action = this.actionCounter++;
			const slot = INVENTORY_START_SLOT + offset;
			this.client.write("window_click", {
				windowId: replaceWindowId,
				slot,
				mouseButton: 0,
				action,
				mode: 1,
				item: { present: false },
			});
		});

		// move to the chute
		const chuteLocation = new Vec3(
			this.armorSet.relativeChuteLocation.x + position.x,
			this.armorSet.relativeChuteLocation.y + position.y,
			this.armorSet.relativeChuteLocation.z + position.z
		);
		const chuteVelocity = new Vec3(
			chuteLocation.x - position.x,
			chuteLocation.y - position.y,
			chuteLocation.z - position.z
		)
			.normalize()
			.scale(CHUTE_SPEED);
		const distanceToChute = position.distanceTo(chuteLocation);
		let distanceTraveled = 0;
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
			this.client.write("position_look", {
				x: position.x,
				y: position.y,
				z: position.z,
				yaw: 0,
				pitch: 0,
				onGround: true,
				time: 0,
			});
			if (distanceTraveled >= distanceToChute) break;
			await util.sleep(1 / util.TPS);
		}

		// fall
		const fallStartHeight = position.y;
		const groundHeight = fallStartHeight - FALL_DISTANCE;
		let fallVelocity = INITIAL_VELOCITY;
		while (true) {
			position.y += fallVelocity;
			const onGround = position.y < groundHeight;
			position.y = Math.max(groundHeight, position.y);
			this.client.write("position_look", {
				x: position.x,
				y: position.y,
				z: position.z,
				yaw: 0,
				pitch: 0,
				onGround,
				time: 0,
			});
			if (onGround) break;
			fallVelocity += G / util.TPS;
			await util.sleep(1 / util.TPS);
		}

		// die
		const { health } = await this.recv("update_health");
		if (health !== 0) {
			this.chat("Error! I didn't die!");
		} else {
			// respawn so orbs don't get stuck swirling around the dead bot
			this.client.write("client_command", { actionId: 0 });
			await this.recv("position");
		}
		this.disconnect();
	}
}

export class XPManager {
	host: string;
	port: number;
	armorSets: ArmorSet[];
	started: boolean;
	constructor(host: string, port: number, armorSets: ArmorSet[]) {
		this.host = host;
		this.port = port;
		this.armorSets = armorSets;
		this.newYeetEntry = this.newYeetEntry.bind(this);
		this.started = false;
	}
	newYeetEntry(armorSet: ArmorSet): Promise<boolean> {
		const config = {
			host: this.host,
			port: this.port,
			username: (util.HIDE_MESSAGE + uuidv1()).substring(0, 16),
		};
		const yeeter = new Yeeter(config, armorSet);
		return yeeter.yeetOrTimeOut();
	}
	async start(amount: number): Promise<void> {
		if (this.started) {
			throw "XP already started!";
		}
		this.started = true;

		let remainingBots = Math.ceil(amount / XP_PER_BOT);

		const armorSets = this.armorSets.slice(
			0,
			Math.min(this.armorSets.length, remainingBots)
		);
		const simultaneousYeeters = armorSets.length;

		let startTime = performance.now() / 1000;
		let yeetEntries = armorSets.map(this.newYeetEntry);

		while (yeetEntries.length) {
			// ideal time per wave to match ORB_INGEST_RATE
			const desiredTime =
				(yeetEntries.length * ORBS_PER_BOT) / ORB_INGEST_RATE;

			// synchronize waves of yeeters to minimize chance of interference with adjacent chutes
			const results = await Promise.all(yeetEntries);
			if (!this.started) throw "Early stop!";

			const elapsedTime = performance.now() / 1000 - startTime;
			remainingBots -= results.filter(result => result).length;
			const neededBots = Math.min(remainingBots, simultaneousYeeters);

			// delay waves to perfectly match desiredTime
			let delay = desiredTime - elapsedTime;
			if (delay < 0) {
				console.log(
					`Underrun! Not enough armor sets to supply XP at maximum rate.`
				);
				delay = 0;
			}
			await util.sleep(delay);

			startTime = performance.now() / 1000;
			yeetEntries = _.range(neededBots).map((index) =>
				this.newYeetEntry(armorSets[index])
			);
		}
		this.started = false;
	}
	stop() {
		this.started = false;
	}
}

export const levelDifference = function levelDifference(
	startLevel: number,
	endLevel: number
) {
	const levelToExperience = (level: number) => {
		// https://minecraft.gamepedia.com/Experience#Leveling_up
		if (level <= 16) {
			return level * level + 6 * level;
		} else if (level <= 31) {
			return 2.5 * level * level - 40.5 * level + 360;
		} else {
			return 4.5 * level * level - 162.5 * level + 2220;
		}
	};
	return levelToExperience(endLevel) - levelToExperience(startLevel);
};
