import { Vec3 } from "vec3";
import _ from "lodash";
import { v1 as uuidv1 } from "uuid";
import { performance } from "perf_hooks";

import * as util from "./util";
import { Blonbot, BotConfig } from "./blonbot";

const ORB_INGEST_RATE = 10; // player can ingest 1 orb every 2 gt
const ADVANCEMENT_XP = 100; // Cover Me in Debris gives 100 XP
const MAX_DROPPED_XP = 100;

const levelToExperience = function levelToExperience(level: number) {
	// https://minecraft.gamepedia.com/Experience#Leveling_up
	if (level <= 16) {
		return level * level + 6 * level;
	} else if (level <= 31) {
		return 2.5 * level * level - 40.5 * level + 360;
	} else {
		return 4.5 * level * level - 162.5 * level + 2220;
	}
};

const experienceToLevel = function experienceToLevel(points: number) {
	// inverted by hand from levelToExperience
	if (points <= 352) {
		return Math.floor(Math.sqrt(9 + points) - 3);
	} else if (points <= 1507) {
		return Math.floor((40.5 + Math.sqrt(10 * points - 1959.75)) / 5);
	} else {
		return Math.floor((162.5 + Math.sqrt(18 * points - 13553.75)) / 9);
	}
}

const roundToOrbSize = function roundToOrbSize(value: number) {
	// net/minecraft/entity/ExperienceOrbEntity.java
	if (value >= 2477) {
		return 2477;
	} else if (value >= 1237) {
		return 1237;
	} else if (value >= 617) {
		return 617;
	} else if (value >= 307) {
		return 307;
	} else if (value >= 149) {
		return 149;
	} else if (value >= 73) {
		return 73;
	} else if (value >= 37) {
		return 37;
	} else if (value >= 17) {
		return 17;
	} else if (value >= 7) {
		return 7;
	} else {
		return value >= 3 ? 3 : 1;
	}
};

const dropXp = function dropXp(level: number) {
	// net/minecraft/entity/LivingEntity.java
	let i = Math.min(level * 7, MAX_DROPPED_XP);
	const orbs = [];
	while (i > 0) {
		const orb = roundToOrbSize(i);
		i -= orb;
		orbs.push(orb);
	}
	return orbs;
};

export const levelDifference = function levelDifference(
	startLevel: number,
	endLevel: number
) {
	return levelToExperience(endLevel) - levelToExperience(startLevel);
};

export const XP_PER_GENERATOR = _.sum(dropXp(experienceToLevel(ADVANCEMENT_XP)));
const GENERATOR_TIMEOUT = 5; // seconds
const CHUTE_SPEED = 12; // m/s
const G = -1.5; // m/s/s
// const INITIAL_VELOCITY = -2; // m/s
const INITIAL_VELOCITY = -1; // m/s
const TERMINAL_VELOCITY = -40.0; // m/s
const FALL_DISTANCE = 24; // meters

const INVENTORY_START_SLOT = 59;

interface GeneratorConfig {
	relativeContainerLocation: Vec3;
	relativeChuteLocation: Vec3;
	containerSlots: number[];
}

interface CondenserConfig {
	username: string;
	targetAmount: number;
}

class XpBot extends Blonbot {
	constructor(config: BotConfig) {
		super(config);
	}

	async suicide(fall_distance: number): Promise<boolean> {
		if (!this.connected) return true;
		if (!this.position) {
			const { x, y, z } = await this.recv("position");
			this.position = new Vec3(x, y, z);
		}
		const position = this.position.clone();
		const fallStartHeight = position.y;
		const groundHeight = fallStartHeight - fall_distance;
		let fallVelocity = INITIAL_VELOCITY;
		while (true) {
			position.y += fallVelocity;
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
			this.chat("Error! I didn't die!");
		} else {
			// respawn so orbs don't get stuck swirling around the dead bot
			this.client.write("client_command", { actionId: 0 });
			await this.recv("position");
		}
		return true;
	}
}

class XpCondenser extends XpBot {
	targetAmount: number;
	constructor(config: BotConfig, condenserConfig: CondenserConfig) {
		super(config);
		this.condense = this.condense.bind(this);
		this.targetAmount = condenserConfig.targetAmount;
	}
	async condense(): Promise<void> {
		this.client.write("client_command", { actionId: 0 });
		while (true) {
			let totalExperience = 0;
			while (totalExperience < this.targetAmount) {
				totalExperience = (await this.recv("experience")).totalExperience;
			}
			await this.suicide(30);
		}
	}
}

class XpGenerator extends XpBot {
	relativeContainerLocation: Vec3;
	relativeChuteLocation: Vec3;
	containerSlots: number[];
	actionCounter: number;
	constructor(config: BotConfig, generatorConfig: GeneratorConfig) {
		super(config);
		this.actionCounter = 1;
		this.relativeContainerLocation = generatorConfig.relativeContainerLocation;
		this.relativeChuteLocation = generatorConfig.relativeChuteLocation;
		this.containerSlots = generatorConfig.containerSlots;
	}
	async generateOrTimeOut(): Promise<boolean> {
		console.log("doin shit")
		let timeout: NodeJS.Timeout;
		const timeoutPromise = new Promise<boolean>(r => {
			timeout = setTimeout(() => {
				console.log(`Bot ${this.username} timed out. Disconnecting.`);
				r(true);
			}, 1000 * GENERATOR_TIMEOUT);
		});
		return Promise.race([
			timeoutPromise,
			this.generate().then(() => {
				clearTimeout(timeout);
				return true;
			}),
		]);
	}
	async generate(): Promise<void> {
		if (!this.position) {
			const { x, y, z } = await this.recv("position");
			this.position = new Vec3(x, y, z);
		}

		// take the netherite armor out of the container
		const containerLocation = new Vec3(
			Math.floor(this.position.x + this.relativeContainerLocation.x),
			Math.floor(this.position.y + this.relativeContainerLocation.y),
			Math.floor(this.position.z + this.relativeContainerLocation.z)
		);

		this.activateBlock(containerLocation);
		const retrieveWindowId = 1;
		// const { windowId: retrieveWindowId } = await this.recv("open_window");
		const retrieveActions = this.containerSlots.map((slot, index) => {
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
		const replaceWindowId = 2;
		// const { windowId: replaceWindowId } = await this.recv("open_window");
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
			this.relativeChuteLocation.x + this.position.x,
			this.relativeChuteLocation.y + this.position.y,
			this.relativeChuteLocation.z + this.position.z
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

	}
}

interface XpUnit {
	generators: GeneratorConfig[];
	condenser: CondenserConfig | null;
}

const getUnitOutput = (unit: XpUnit) => {
	const perGenerator = dropXp(experienceToLevel(ADVANCEMENT_XP));
	const generated = _.flatten(_.times(unit.generators.length, _.constant(perGenerator)));
	console.log({generated});
	if (unit.condenser === null) return generated;
	return dropXp(experienceToLevel(_.sum(generated)));
};

export class XpManager {
	host: string;
	port: number;
	units: XpUnit[];
	started: boolean;
	constructor(host: string, port: number, units: XpUnit[]) {
		this.host = host;
		this.port = port;
		this.units = units;
		this.newGenerator = this.newGenerator.bind(this);
		this.started = false;
	}
	newCondenser(condenserConfig: CondenserConfig): XpCondenser {
		const config = {
			host: this.host,
			port: this.port,
			username: condenserConfig.username,
		};
		return new XpCondenser(config, condenserConfig);
	}
	newGenerator(generatorConfig: GeneratorConfig): XpGenerator {
		const config = {
			host: this.host,
			port: this.port,
			username: (util.HIDE_MESSAGE + uuidv1().replace("-", "")).substring(0, 16),
		};
		return new XpGenerator(config, generatorConfig);
	}
	async start(amount?: number): Promise<void> {
		if (this.started) {
			throw "XP already started!";
		}
		this.started = true;


		// const generatorConfigs = this.generatorConfigs.slice(
		// 	0,
		// 	Math.min(this.generatorConfigs.length, remainingBots)
		// );
		// const simultaneousGenerators = generatorConfigs.length;

		let startTime = performance.now() / 1000;

		// let generators = this.units.flatMap(unit => unit.generators.map(this.newGenerator));

		let remainingWaves;
		if (amount) {
			remainingWaves = Math.ceil(amount / _.sum(this.units.flatMap(getUnitOutput)));
		} else {
			remainingWaves = Infinity;
		}

		const orbsPerWave = _.sum(this.units.map(unit => getUnitOutput(unit).length));
		console.log({orbsPerWave});

		// ideal time per wave to match ORB_INGEST_RATE
		const desiredTime = orbsPerWave / ORB_INGEST_RATE;
		console.log({desiredTime});

		// @ts-ignore
		const condensers = this.units.filter(unit => unit.condenser !== null).map(unit => this.newCondenser(unit.condenser));
		condensers.map(condenser => condenser.condense());

		while (remainingWaves) {
			startTime = performance.now() / 1000;
			const generators = this.units.flatMap(unit => unit.generators.map(this.newGenerator));

			// synchronize waves of generators to minimize chance of interference with adjacent chutes
			await Promise.all(generators.map(generator => generator.generateOrTimeOut()));
			await Promise.all(generators.map(generator => generator.suicide(FALL_DISTANCE)));

			if (!this.started) throw "Early stop!";

			const endTime = performance.now() / 1000;
			const elapsedTime = endTime - startTime;
			console.log({elapsedTime});

			// delay waves to perfectly match desiredTime
			let delay = desiredTime - elapsedTime;
			if (delay < 0) {
				console.log(
					`Underrun! Not enough armor sets to supply XP at maximum rate.`
				);
				delay = 0;
			}

			console.log({delay, remainingWaves});

			remainingWaves -= 1;

			if (remainingWaves) await util.sleep(delay);
			generators.map(generator => generator.disconnect());

		}

		this.started = false;
	}
	stop() {
		this.started = false;
	}
}
