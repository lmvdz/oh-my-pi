import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { fleetHelp as commandHelp } from "../cli/command-help";
import { runFleetStatus } from "../cli/fleet-cli";

export default class Fleet extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: ["status"] }),
	};
	static flags = {
		limit: Flags.integer({ char: "n", description: "Number of recent routing decisions", default: 10 }),
		"gateway-url": Flags.string({ description: "Auth gateway URL" }),
		"routing-log": Flags.string({ description: "Switchyard --routing-log-file path" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Fleet);
		if (!args.action) {
			renderCommandHelp("omp", "fleet", Fleet);
			return;
		}
		await runFleetStatus({ limit: flags.limit, gatewayUrl: flags["gateway-url"], routingLog: flags["routing-log"] });
	}
}
