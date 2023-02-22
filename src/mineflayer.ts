import { Client } from "minecraft-protocol";
import mineflayer from "mineflayer";
import { Item } from "prismarine-item";
import { Block } from "prismarine-block";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { performance } from "perf_hooks";
import JZZ from "jzz";
import assert from "assert";
import fs from "fs";
import sanitize from "sanitize-filename";
import _ from "lodash";

// @ts-ignore
import SMF from "jzz-midi-smf";
SMF(JZZ);

import * as util from "./util";
import { Behavior, Bot, BotConfig } from "./blonbot";

const promisify = (fn: any) => {
	return (...args: any) => {
		return new Promise((resolve, reject) => {
			fn(...args, resolve);
		});
	};
};

const MIDI_DIRECTORY = "./midi/";

export class MineflayerBot extends Bot {
	bot: mineflayer.Bot;
	client: Client;
	username: string;
	host: string;
	port: number;
	ready: Promise<void>;
	persist: boolean;
	connected: boolean;
	startTime: number;
	injectAllowed: Promise<void>;
	constructor(config: BotConfig) {
		super();

		this.dig = this.dig.bind(this);
		this.midi = this.midi.bind(this);
		this.dupe = this.dupe.bind(this);
		this.surf = this.surf.bind(this);

		this.username = config.username;
		this.host = config.host;
		this.port = config.port;
		this.bot = mineflayer.createBot({
			...config,
			loadInternalPlugins: true,
		});
		this.startTime = performance.now();

		this.client = this.bot._client;

		this.injectAllowed = promisify(this.bot.once.bind(this.bot))(
			"inject_allowed"
		).then(() => util.sleep(0));
		this.ready = Promise.all([
			this.injectAllowed,
			promisify(this.bot.once.bind(this.bot))("spawn"),
			promisify(this.bot.once.bind(this.bot))("game"),
		]).then(() => {});

		this.client.on("position", ({ x, y, z }) => {
			console.log("pos", { x, y, z});
			this.position = new Vec3(x, y, z);
		});

		this.connected = true;
		this.persist = false;

		this.behaviors.surf = this.surf;
		this.behaviors.dig = this.dig;
		this.behaviors.dupe = this.dupe;
		this.behaviors.midi = this.midi;

		this.client.on("position", ({ x, y, z }) => {
			this.position = new Vec3(x, y, z);
		});
	}
	disconnect(reason?: string) {
		this.bot.quit(reason);
		this.connected = false;
	}
	async *dig(): AsyncIterator<any> {
		const { yaw, pitch } = this.bot.entity;

		while (true) {
			// @ts-ignore
			const target = this.bot.blockAtCursor(6);
			if (target && this.bot.canDigBlock(target)) {
				yield await this.bot.dig(target);
				yield await this.bot.look(yaw, pitch); // reset look since bot.dig fucks it up
			}
			yield await util.sleep(1 / util.TPS);
		}
	}
	async *midi(filename?: string): AsyncIterator<any> {
		await this.ready;

		let rightArm = true;

		const punch = async (location: Vec3) => {
			this.bot.lookAt(location);
			this.bot.swingArm(rightArm ? "left" : "right");
			rightArm = !rightArm;
			this.client.write("block_dig", {
				location,
				status: 0,
				face: 0,
			});
			this.client.write("block_dig", {
				location,
				status: 1,
				face: 0,
			});
		};

		interface MinecraftNote {
			instrument: string;
			note: number;
		}
		const instrumentRanges: Record<string, [number, number] | null> = {
			banjo: [54, 78],
			basedrum: null,
			bass: [30, 54],
			bell: [78, 102],
			bit: [54, 78],
			chime: [78, 102],
			cow_bell: [66, 90],
			didgeridoo: [30, 54],
			flute: [66, 90],
			guitar: [42, 66],
			harp: [54, 78],
			hat: null,
			iron_xylophone: [54, 78],
			pling: [54, 78],
			snare: null,
			xylophone: [78, 102],
		};

		const noteBlocks: any = this.bot
			.findBlocks({ maxDistance: 10, matching: 74, count: 1024 })
			.map((point: any) => this.bot.blockAt(point))
			.filter((block: any) => this.bot.canDigBlock(block));
		const orchestra: Record<string, Block[]> = {};
		for (const noteBlock of noteBlocks) {
			// @ts-ignore
			const { instrument } = noteBlock.getProperties();
			const [start, end] = instrumentRanges[instrument] || [0, 0];
			const rangeSize = end - start + 1;
			if (!orchestra[instrument]) {
				orchestra[instrument] = [noteBlock];
			} else if (orchestra[instrument].length < rangeSize) {
				orchestra[instrument].push(noteBlock);
			}
		}

		// tune
		for (const instrument in orchestra) {
			const section = orchestra[instrument];
			if (instrumentRanges[instrument] === null) continue;
			// @ts-ignore
			const [start, end] = instrumentRanges[instrument];
			const rangeSize = end - start + 1;
			if (section.length < rangeSize) {
				this.chat(`Error! not enough note blocks for ${instrument}`);
			}
			section.map((noteBlock: Block, targetNote: number) => {
				// @ts-ignore
				let { note } = noteBlock.getProperties();
				while (note !== targetNote) {
					this.bot.activateBlock(noteBlock);
					note = (note + 1) % rangeSize;
				}
			});
		}

		const makeTransposer = (
			instrument: string
		): ((note: number) => MinecraftNote | null) => {
			const fallback = (fallbacks: string[]) => {
				return (note: number) => {
					for (const instrument of fallbacks) {
						const range = instrumentRanges[instrument];
						if (range === null)
							return {
								instrument,
								note: 0,
							};
						const [start, end] = range;
						if (start <= note && note <= end) {
							return {
								instrument,
								note: note - start,
							};
						}
					}
					return null;
				};
			};
			if (
				instrument.match(/harp/) ||
				instrument.match(/piano/)
			) {
				return fallback(["harp", "bass", "bell"]);
			} else if (
				instrument.match(/guitar/)
			) {
				return fallback(["guitar", "bass", "harp", "bells"]);
			} else if (
				instrument.match(/flute/) ||
				instrument.match(/whistle/)
			) {
				return fallback(["flute", "didgeridoo"]);
			} else if (
				instrument.match(/banjo/) 
			) {
				return fallback(["banjo", "guitar"]);
			} else if (
				instrument.match(/drumset/)
			) {
				return (note: number) => {
					let instrument;
					if (_.includes([35, 36], note)) {
						instrument = "basedrum";
					} else if (_.includes([37], note)) {
						instrument = "snare";
					} else if (_.includes([44, 46], note)) {
						instrument = "hat";
					}
					if (instrument) {
						return {
							instrument,
							note: 0,
						}
					}
					return null;
				};
			} else {
				// fallback to piano-like
				return fallback(["harp", "bass", "bell"]);
			}
		};

		const transposers: ((note: number) => MinecraftNote | null)[] = [];
		const defaultTransposer = makeTransposer("flute");
		const output = JZZ.Widget({
			_receive: function (msg: any) {
				if (msg.ff === 3 && msg.getText()) {
					transposers[msg.track] = makeTransposer(
						msg.getText().toLowerCase()
					);
					return;
				}
				if (!msg.isNoteOn()) return;

				const transposer = transposers[msg.track] || defaultTransposer;

				const minecraftNote = transposer(msg.getNote());
				if (minecraftNote === null) return;

				const { note, instrument } = minecraftNote;

				const section = orchestra[instrument];
				if (!section) {
					console.log("this would sound a lot better if I had some ", instrument);
					return;
				};
				const noteBlock = section[note];
				if (!noteBlock) {
					console.log("this would sound a lot better if I had MORE ", instrument, {note});
					return;
				};
				punch(noteBlock.position);
			},
		});
		var input = JZZ().openMidiIn(/USB/);
		input && input.connect(output);
		if (filename) {
			try {
				const midi = await fs.promises.readFile(
					`${MIDI_DIRECTORY}/${sanitize(filename)}.mid`,
					"binary"
				);
				// @ts-ignore
				const smf = JZZ.MIDI.SMF(midi);
				const player = smf.player();
				player.connect(output);
				player.play();
				player.loop(true);
			} catch (e) {
				console.error({ e });
				this.chat(e.message);
			}
		}
	}
	async *dupe(): AsyncIterator<void> {
		await util.sleep(2);
		// const hugeString = _.repeat("ࠀ", 21845);
		// const pages = [
		// 	hugeString,
		// 	..._.times(39, () => _.repeat("a", 256)),
		// ];


		const mcData = minecraftData(this.bot.version);

		await this.bot.toss(mcData.itemsByName.red_bed.id, null, null);
		await util.sleep(1);


		const buffer = await fs.promises.readFile("./dupe.bin", "binary");
		console.log({buffer});
		this.client.writeRaw(buffer);

		// console.log("dupin, pages are ", {pages});

		// try {
		// 	this.client.write("edit_book", {
		// 		new_book: {
		// 			present: true,
		// 			itemId: 825,
		// 			itemCount: 1,
		// 			nbtData: {
		// 				type: "compound",
		// 				name: "",
		// 				value: {
		// 					pages: {
		// 						type: "list",
		// 						value: { type: "string", value: pages },
		// 					},
		// 					title: { type: "string", value: "a" },
		// 				},
		// 			}
		// 		},
		// 		signing: true,
		// 		hand: 0,
		// 	});
		// 	console.log("wrote");
		// } catch (e) {
		// 	console.error(e);
		// }
	}
	async *surf(x: string, y: string, z: string) {
		await this.ready;

		const start = performance.now();

		// const mcData = minecraftData(this.bot.version);

		const goal = new Vec3(+x, +y, +z);

		let timeout: number;

		const surf = (position: Vec3) => {
			if (!this.bot.entities) return;
			const entities = this.bot.entities;
			const vehicles = Object.values(entities).filter((entity) => {
				if (entity.kind !== "Vehicles") return false;
				if (position.distanceTo(entity.position) > 6) return false;
				return entity.position.distanceTo(goal) < position.distanceTo(goal);
			});

			if (!vehicles) return;

			const bestVehicle = _.minBy(vehicles, vehicle => vehicle.position.distanceTo(goal));
			if (!bestVehicle) return;

			const bestVehicles = _.sortBy(vehicles, vehicle => vehicle.position.distanceTo(goal));


			const bestVehicleCoords = bestVehicle.position;
			// console.log({bestVehicleCoords}, "next best", bestVehicles[1] && bestVehicles[1].position, "bot pos", this.bot.entity.position, "nmp pos", this.position);

			const vehicle = (this.bot as any).vehicle;
			if (bestVehicle === vehicle) return;
			console.log("mounting");
			this.bot.mount(bestVehicle);
		};
		// interval = setInterval(surf, 1000 / util.TPS);

		let previousPosition = this.position;
		while (true) {
			if (this.position) {
				if (this.position === previousPosition) {
					this.bot.dismount();
				}
				surf(this.position);
			}
			console.log("elapsed", performance.now() - start, "pos", this.position);
			previousPosition = this.position;
			try {
				// const {x, y, z}  / util.TPS= await util.timeout(this.recv("position"), 1 / util.TPS);
				await util.timeout(this.recv("position"), 1 / util.TPS);
				// await util.timeout(this.recv("attach_entity"), 1 / util.TPS);
			} catch {}
		}
	};
}
