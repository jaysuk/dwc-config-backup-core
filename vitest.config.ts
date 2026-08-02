import { defineConfig } from "vitest/config";

// Pure-logic tests. happy-dom supplies window/localStorage/Blob/crypto for the storage, encryption
// and archive modules; nothing here mounts a component or needs a running DWC.
export default defineConfig({
	test: {
		environment: "happy-dom",
		include: ["test/**/*.test.ts"],
		coverage: { provider: "v8", include: ["src/**"], reporter: ["text", "text-summary"] },
	},
});
