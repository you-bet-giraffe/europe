import { test } from "node:test";
import assert from "node:assert/strict";
import { World, isFiniteVec3 } from "./world";
import { SPAWN_POINT } from "../../shared/types";

test("addPlayer spawns at SPAWN_POINT with zero rotation", () => {
  const world = new World();
  const p = world.addPlayer("a");
  assert.deepEqual(p.position, SPAWN_POINT);
  assert.equal(p.rotation, 0);
  // Spawn position must be a copy, not a shared reference to the constant.
  assert.notEqual(p.position, SPAWN_POINT);
});

test("isFiniteVec3 accepts finite vectors and rejects bad input", () => {
  assert.equal(isFiniteVec3({ x: 1, y: 2, z: 3 }), true);
  assert.equal(isFiniteVec3({ x: 0, y: 0, z: 0 }), true);
  assert.equal(isFiniteVec3({ x: NaN, y: 0, z: 0 }), false);
  assert.equal(isFiniteVec3({ x: Infinity, y: 0, z: 0 }), false);
  assert.equal(isFiniteVec3({ x: 1, y: 2 }), false);
  assert.equal(isFiniteVec3(null), false);
  assert.equal(isFiniteVec3("nope"), false);
  assert.equal(isFiniteVec3({ x: "1", y: 2, z: 3 }), false);
});

test("movePlayer applies a valid move", () => {
  const world = new World();
  world.addPlayer("a");
  assert.equal(world.movePlayer("a", { x: 10, y: 20, z: 30 }, 1.5), true);
  const p = world.getPlayer("a")!;
  assert.deepEqual(p.position, { x: 10, y: 20, z: 30 });
  assert.equal(p.rotation, 1.5);
});

test("movePlayer rejects non-finite position and leaves state intact", () => {
  const world = new World();
  world.addPlayer("a");
  world.movePlayer("a", { x: 5, y: 5, z: 5 }, 0);
  for (const bad of [
    { x: NaN, y: 0, z: 0 },
    { x: Infinity, y: 0, z: 0 },
    { x: 0, y: -Infinity, z: 0 },
  ]) {
    assert.equal(world.movePlayer("a", bad, 0), false);
  }
  // Last good state preserved.
  assert.deepEqual(world.getPlayer("a")!.position, { x: 5, y: 5, z: 5 });
});

test("movePlayer rejects non-finite rotation", () => {
  const world = new World();
  world.addPlayer("a");
  assert.equal(world.movePlayer("a", { x: 1, y: 1, z: 1 }, NaN), false);
});

test("movePlayer clamps elevation into the sane envelope", () => {
  const world = new World();
  world.addPlayer("a");
  world.movePlayer("a", { x: 0, y: 9_999_999, z: 0 }, 0);
  assert.equal(world.getPlayer("a")!.position.y, 12000);
  world.movePlayer("a", { x: 0, y: -9_999_999, z: 0 }, 0);
  assert.equal(world.getPlayer("a")!.position.y, -500);
});

test("movePlayer is a no-op for an unknown player", () => {
  const world = new World();
  assert.equal(world.movePlayer("ghost", { x: 0, y: 0, z: 0 }, 0), false);
});

test("playersNear filters by horizontal radius and includes the point itself", () => {
  const world = new World();
  world.addPlayer("a");
  world.addPlayer("b");
  world.addPlayer("c");
  world.movePlayer("a", { x: 0, y: 0, z: 0 }, 0);
  world.movePlayer("b", { x: 100, y: 500, z: 0 }, 0); // near (Y ignored)
  world.movePlayer("c", { x: 5000, y: 0, z: 0 }, 0);  // far

  const near = world.playersNear({ x: 0, y: 0, z: 0 }, 1000);
  const ids = near.map(p => p.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("removePlayer drops the player", () => {
  const world = new World();
  world.addPlayer("a");
  world.removePlayer("a");
  assert.equal(world.getPlayer("a"), undefined);
  assert.equal(world.getPlayers().length, 0);
});
