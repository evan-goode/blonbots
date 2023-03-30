import { Vec3 } from "vec3";
import _ from "lodash";
import { v1 as uuidv1 } from "uuid";
import { performance } from "perf_hooks";
import { Worker } from "worker_threads";
import pEvent from "p-event";

import {
	ADVANCEMENT_XP,
	GeneratorConfig,
	XpGenerator,
} from "./XpBot";
import * as xpUtil from "./util";
import * as util from "../util";
import { Blonbot, BotConfig } from "../blonbot";

const GENERATOR_TIMEOUT = 10; // seconds

export interface XpUnit {
	generators: GeneratorConfig[];
}

const getUnitOutput = (unit: XpUnit) => {
	const perGenerator = xpUtil.dropXp(
		xpUtil.experienceToLevel(ADVANCEMENT_XP)
	);
	const generated = _.flatten(
		_.times(unit.generators.length, _.constant(perGenerator))
	);
	return generated;
};

const getUnitTime = (unit: XpUnit): number => {
	const perGenerator = xpUtil.dropXp(xpUtil.experienceToLevel(ADVANCEMENT_XP));
	const orbCount = unit.generators.length * perGenerator.length;
	return orbCount / xpUtil.ORB_INGEST_RATE;
}

export default class XpManager {
	host: string;
	port: number;
	unit: XpUnit;
	running: boolean;
	generators: Worker[];
	constructor(host: string, port: number, unit: XpUnit) {
		this.host = host;
		this.port = port;
		this.unit = unit;
		this.running = false;
		this.generators = [];
	}
	postMessage(worker: Worker, type: string, data: object = {}) {
		worker.postMessage({ type, data });
	}
	recvMessage(worker: Worker, messageType: string) {
		return pEvent(worker, "message", ({type, data}) => type === messageType);
	}
	async makeGenerators(): Promise<Worker[]> {
		const generators = this.unit.generators.map((generatorConfig) => {
			return new Worker("./build/xp/generatorWorker.js");
		});

		console.log("waiting for ready");
		await Promise.all(generators.map((generator) => this.recvMessage(generator, "ready")));
		console.log("all are ready");

		return generators;
	}

	async wave(): Promise<void> {
		const generators = this.generators;
		const doWave = async (): Promise<void> => {
			_.zip<any>(generators, this.unit.generators).forEach(
				([generator, generatorConfig]) => {
					const botConfig = {
						host: this.host,
						port: this.port,
						username: (
							util.HIDE_MESSAGE + uuidv1().replace("-", "")
						).substring(0, 16),
					};
					this.postMessage(generator, "reset", {
						botConfig,
						generatorConfig,
					});
					this.recvMessage(generator, "reset").then(() => {
						this.postMessage(generator, "generate"); // initiate generate asynchronously
					});
				}
			);

			// synchronize waves of generators to minimize chance of interference with adjacent chutes
			await Promise.all(
				generators.map((generator) =>
					this.recvMessage(generator, "generate")
				)
			);

			generators.map((generator) =>
				this.postMessage(generator, "suicide")
			);
			await Promise.all(
				generators.map((generator) =>
					this.recvMessage(generator, "suicide")
				)
			);

			generators.map((generator) => this.postMessage(generator, "disconnect"));
		}

		const timeoutPromise = async (): Promise<void> => {
			await util.sleep(GENERATOR_TIMEOUT);
			throw Error("timed out!")
		};

		return await Promise.race([doWave(), timeoutPromise()]);
	}
	async start(amount?: number): Promise<number> {
		if (this.running) {
			throw "XP already running!";
		}
		this.running = true;

		let startTime = performance.now() / 1000;

		let xpPerWave = _.sum(getUnitOutput(this.unit));

		let remainingWaves;
		if (amount) {
			remainingWaves = Math.ceil(amount / xpPerWave);
		} else {
			remainingWaves = Infinity;
		}

		const orbsPerWave = getUnitOutput(this.unit).length;
		const unitTime = getUnitTime(this.unit);
		console.log({ xpPerWave, orbsPerWave });

		// ideal time per wave to match ORB_INGEST_RATE
		const desiredTime = Math.max(unitTime, orbsPerWave / xpUtil.ORB_INGEST_RATE);
		console.log({ desiredTime });

		const xpPerHour = 3600 * xpPerWave / desiredTime;
		console.log({xpPerHour});

		this.generators = await this.makeGenerators();

		let totalGenerated = 0;
		while (remainingWaves) {
			startTime = performance.now() / 1000;

			let success = false;
			try {
				await this.wave();
				success = true;
			} catch (e) {
				this.generators.map(generator => this.postMessage(generator, "exit"));
				console.error("XP Error: ", e);
				// Easiest to just make brand new workers. If we used a proper
				// worker library, cancellable promises, etc, this could maybe
				// work, but as-is, old bots would interfere with new bots
				this.generators = await this.makeGenerators();
			}

			if (!this.running) break;

			if (!success) {
				const failDelay = 1;
				console.error(`Failed, starting next wave in ${failDelay} second(s)`);
				await util.sleep(failDelay);
				continue;
			}

			totalGenerated += xpPerWave;

			const endTime = performance.now() / 1000;
			const elapsedTime = endTime - startTime;

			// delay waves to perfectly match desiredTime
			let delay = desiredTime - elapsedTime;
			if (delay < 0) {
				console.log(
					`Underrun! Not enough armor sets to supply XP at maximum rate.`
				);
				delay = 0;
			}

			console.log(JSON.stringify({ elapsedTime: elapsedTime.toFixed(2), desiredTime, delay, remainingWaves }).replace("\n", " "));

			remainingWaves -= 1;

			if (remainingWaves) await util.sleep(delay);
		}
		
		this.generators.map((generator) => this.postMessage(generator, "exit"));

		this.running = false;

		return totalGenerated;
	}
	stop() {
		this.running = false;
	}
}
