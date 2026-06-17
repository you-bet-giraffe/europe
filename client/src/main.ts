import { AbstractEngine, Engine, WebGPUEngine } from "@babylonjs/core";
import { Game } from "./game";
import { TEST_MODE } from "./testMode";

async function createEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  // WebGL2 is the default backend: Babylon's WebGPU path currently renders PBR
  // materials flat white (and terrain darkens at distance), so WebGL2 is the
  // reliable choice until those are fixed. Opt into WebGPU with ?webgpu to test
  // that path; test mode (?test) always stays on WebGL2 for deterministic CI.
  const wantsWebGPU = !TEST_MODE && new URLSearchParams(location.search).has("webgpu");

  if (wantsWebGPU && await WebGPUEngine.IsSupportedAsync) {
    const engine = new WebGPUEngine(canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
    });
    await engine.initAsync();
    console.log("Using WebGPU (opted in via ?webgpu)");
    return engine;
  }

  console.log(wantsWebGPU ? "WebGPU not supported, using WebGL2" : "Using WebGL2");
  return new Engine(canvas, true, { adaptToDeviceRatio: true });
}

async function main() {
  const canvas = document.getElementById("render-canvas") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas not found");

  const engine = await createEngine(canvas);
  const game = new Game(engine, canvas);
  await game.init();

  engine.runRenderLoop(() => game.update());
  window.addEventListener("resize", () => engine.resize());
}

main().catch((err) => {
  console.error(err);
  // Surface init errors visibly on screen
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;top:10px;left:10px;color:red;font:14px monospace;z-index:9999;white-space:pre";
  div.textContent = String(err);
  document.body.appendChild(div);
});
