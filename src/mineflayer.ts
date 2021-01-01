import { Client } from "minecraft-protocol";
import mineflayer from "mineflayer";
import { Block } from "prismarine-block";
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

		this.username = config.username;
		this.host = config.host;
		this.port = config.port;
		this.bot = mineflayer.createBot(config);
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
			this.position = new Vec3(x, y, z);
		});

		this.connected = true;
		this.persist = false;

		this.behaviors.dig = this.dig;
		this.behaviors.midi = this.midi;
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
}
