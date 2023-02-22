import { parentPort } from 'worker_threads';
import { XpGenerator } from "./XpBot";

let generator: XpGenerator | null = null;

const postMessage = (type: string, data: object = {}) => {
	parentPort!.postMessage({type, data});
};

parentPort!.on("message", async ({type, data}: any) => {
	if (type === "reset") {
		const {botConfig, generatorConfig} = data;
		if (generator !== null) {
			generator.disconnect();
		}
		generator = new XpGenerator(botConfig, generatorConfig);
		postMessage("reset");
		return;
	}

	if (type === "exit") {
		if (generator !== null) {
			generator.disconnect();
		}
		process.exit(0);
	}

	if (generator === null) return;

	if (type === "generate") {
		await generator.generateOrTimeOut();
		postMessage("generate");
	} else if (type === "suicide") {
		await generator.suicide();
		postMessage("suicide");
	} else if (type === "disconnect") {
		try {
			generator.disconnect();
		} catch {}
		postMessage("disconnect");
	}
});

postMessage("ready");
