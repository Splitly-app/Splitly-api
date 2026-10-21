import { Elysia } from "elysia";
import { readConfig } from "./config";
import { createRuntimeApp } from "./runtime";

const app = createRuntimeApp(readConfig(process.env));
if (!(app instanceof Elysia)) throw new TypeError("Invalid Elysia app");

export default app;
