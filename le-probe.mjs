import { loadEnv } from "vite";
const t = Date.now();
const env = loadEnv("test", process.cwd(), "");
console.log("loadEnv done", Date.now() - t, Object.keys(env).filter(k => k.includes("PLATFORM_DB") || k === "DATABASE_URL"));
