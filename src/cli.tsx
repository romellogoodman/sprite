#!/usr/bin/env node
import { render } from "ink";
import { App } from "./App.js";

const trust = process.argv.includes("--trust");

render(<App trust={trust} />);
