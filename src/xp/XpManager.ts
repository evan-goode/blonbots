import { Vec3 } from "vec3";
import _ from "lodash";
import { v1 as uuidv1 } from "uuid";
import { performance } from "perf_hooks";
import { Worker } from "worker_threads";
import pEvent from "p-event";

import {
	ADVANCEMENT_XP,
	CondenserConfig,
	GeneratorConfig,
	XpCondenser,
	XpGenerator,
} from "./XpBot";
import * as xpUtil from "./util";
import * as util from "../util";
import { Blonbot, BotConfig } from "../blonbot";

export interface XpUnit {
	generators: GeneratorConfig[];
	condenser: CondenserConfig | null;
}

const getUnitOutput = (unit: XpUnit) => {
	const perGenerator = xpUtil.dropXp(
		xpUtil.experienceToLevel(ADVANCEMENT_XP)
	);
	const generated = _.flatten(
		_.times(unit.generators.length, _.constant(perGenerator))
	);
	if (unit.condenser === null) return generated;
	return xpUtil.dropXp(xpUtil.experienceToLevel(_.sum(generated)));
};

const getUnitTime = (unit: XpUnit): number => {
	const perGenerator = xpUtil.dropXp(xpUtil.experienceToLevel(ADVANCEMENT_XP));
	const orbCount = unit.generators.length * perGenerator.length;
	return orbCount / xpUtil.ORB_INGEST_RATE;
}

export default class XpManager {
	host: string;
	port: number;
	units: XpUnit[];
	started: boolean;
	constructor(host: string, port: number, units: XpUnit[]) {
		this.host = host;
		this.port = port;
		this.units = units;
		this.newCondenserWorker = this.newCondenserWorker.bind(this);
		this.started = false;
	}
	newCondenserWorker(condenserConfig: CondenserConfig): Worker {
		const config = {
			host: this.host,
			port: this.port,
			username: condenserConfig.username,
		};
		return new Worker("./build/xp/condenserWorker.js", {
			workerData: {
				condenserConfig,
				botConfig: config,
			},
		});
	}
	postMessage(worker: Worker, type: string, data: object = {}) {
		worker.postMessage({ type, data });
	}
	recvMessage(worker: Worker, messageType: string) {
		return pEvent(worker, "message", ({type, data}) => type === messageType);
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
			remainingWaves = Math.ceil(
				amount / _.sum(this.units.flatMap(getUnitOutput))
			);
		} else {
			remainingWaves = Infinity;
		}

		const orbsPerWave = _.sum(
			this.units.map((unit) => getUnitOutput(unit).length)
		);
		const slowestUnitTime = _.min<number>(this.units.map((unit) => getUnitTime(unit))) as number;
		console.log({ orbsPerWave });

		// ideal time per wave to match ORB_INGEST_RATE
		const desiredTime = Math.max(slowestUnitTime, orbsPerWave / xpUtil.ORB_INGEST_RATE);
		console.log({ desiredTime });

		const condenserConfigs: CondenserConfig[] = this.units
			.filter((unit) => unit.condenser !== null)
			.map((unit) => unit.condenser!);
		const condensers = condenserConfigs.map((condenserConfig) => {
			return new Worker("./build/xp/condenserWorker.js");
		});
		await Promise.all(
			condensers.map((condenser) => {
				return this.recvMessage(condenser, "ready");
			})
		);

		const condenserTimes: number[] = [];
		condensers.map(condenser => {
			condenser.on("message", ({type, data}) => {
				if (type !== "time") return;
				const { time } = data;
				condenserTimes.push(time);
				if (condenserTimes.length > condensers.length) {
					condenserTimes.shift();
				}
				// console.log({condenserTimes});
			});
		});

		_.zip<any>(condensers, condenserConfigs).map(
			([condenser, condenserConfig]) => {
				const botConfig = {
					host: this.host,
					port: this.port,
					username: condenserConfig.username,
				};
				this.postMessage(condenser, "reset", {
					botConfig,
					condenserConfig,
				});
			}
		);
		await Promise.all(
			condensers.map((condenser) => this.recvMessage(condenser, "reset"))
		);
		condensers.map((condenser) => this.postMessage(condenser, "condense"));

		const generatorConfigs = this.units.flatMap((unit) => unit.generators);
		const generators = generatorConfigs.map((generatorConfig) => {
			return new Worker("./build/xp/generatorWorker.js");
		});

		console.log("waiting for ready");
		await Promise.all(
			generators.map((generator) => this.recvMessage(generator, "ready"))
		);

		console.log("all are ready");

		while (remainingWaves) {
			startTime = performance.now() / 1000;

			_.zip<any>(generators, generatorConfigs).map(
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
						this.postMessage(generator, "generate");
					});
				}
			);

			// console.log("waiting for reset");
			// await Promise.all(
			// 	generators.map((generator) =>
			// 		this.recvMessage(generator, "reset")
			// 	)
			// );

			// console.log("all are reset");

			// synchronize waves of generators to minimize chance of interference with adjacent chutes

			// generators.map((generator) =>
			// 	this.postMessage(generator, "generate")
			// );
			await Promise.all(
				generators.map((generator) =>
					this.recvMessage(generator, "generate")
				)
			);
			// console.log("ALL generate complete");

			generators.map((generator) =>
				this.postMessage(generator, "suicide")
			);
			await Promise.all(
				generators.map((generator) =>
					this.recvMessage(generator, "suicide")
				)
			);
			// console.log("suicide complete");

			if (!this.started) break;

			const endTime = performance.now() / 1000;
			const elapsedTime = endTime - startTime;

			// delay waves to perfectly match desiredTime
			let currentDesiredTime = desiredTime;
			if (condensers.length && condenserTimes.length === condensers.length) {
				currentDesiredTime += _.mean(condenserTimes); // condensers can't absorb XP while they're suiciding
			}
			let delay = currentDesiredTime - elapsedTime;
			if (delay < 0) {
				console.log(
					`Underrun! Not enough armor sets to supply XP at maximum rate.`
				);
				delay = 0;
			}

			console.log({ elapsedTime, desiredTime, currentDesiredTime, delay, remainingWaves });

			remainingWaves -= 1;

			generators.map((generator) => this.postMessage(generator, "disconnect"));

			// await Promise.all(condensers.map((condenser) => {
			// 	return this.recvMessage(condenser, "time");
			// }));

			if (remainingWaves) await util.sleep(delay);
		}
		
		// TODO wait for condensers to drop all xp
		// condensers.map((condenser) => this.postMessage(condenser, "exit"));
		generators.map((generator) => this.postMessage(generator, "exit"));

		this.started = false;
	}
	stop() {
		this.started = false;
	}
}
