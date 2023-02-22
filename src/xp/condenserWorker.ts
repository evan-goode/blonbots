import { parentPort } from 'worker_threads';
import { XpCondenser } from "./XpBot";

const postMessage = (type: string, data: object = {}) => {
	parentPort!.postMessage({type, data});
};

let condenser: XpCondenser | null = null;

parentPort!.on("message", async ({type, data}) => {
	if (type === "reset") {
		const { botConfig, condenserConfig } = data;
		if (condenser !== null) {
			condenser.disconnect();
		}
		condenser = new XpCondenser(botConfig, condenserConfig, (time) => {
			postMessage("time", {time});
		});
		postMessage("reset");
		return;
	}
	if (type === "exit") {
		if (condenser !== null) {
			condenser.disconnect();
		}
		process.exit(0);
	}

	if (condenser === null) return;

	if (type === "condense") {
		condenser.condense();
	} else if (type === "disconnect") {
		condenser.disconnect();
	}
});

postMessage("ready");
