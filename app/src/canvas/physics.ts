// Canvas physics — Matter.js setup for the game-like icon behavior.
//
// Icons are circular physics bodies that:
//   - follow the pointer with spring lag when dragged
//   - bounce off the grid boundaries (restitution 0.6)
//   - bounce off each other (collision response)
//   - float back to source via a seek+avoid steering behavior
//   - idle bob (visual only, not physics)

import Matter from 'matter-js';
import type { IconBody } from './CanvasApp';

// World bounds (the bounded grid). Icons cannot leave these.
export const WORLD_BOUNDS = {
  minX: -2000,
  maxX: 2000,
  minY: -1200,
  maxY: 1200,
};

export const ICON_RADIUS = 32; // physics body radius
export const RESTITUTION = 0.6; // bounciness (0 = no bounce, 1 = perfect)
export const DRAG_DAMPING = 0.15; // friction when dragging
export const SEEK_FORCE = 0.002; // how strongly icons return to source
export const MAX_SPEED = 8; // cap on velocity

/** Create the Matter.js engine + world. */
export function createPhysics(): Matter.Engine {
  const engine = Matter.Engine.create({
    gravity: { x: 0, y: 0 }, // no gravity — top-down 2D
    enableSleeping: false,
  });
  return engine;
}

/** Create the boundary walls (invisible). */
export function createBoundaries(engine: Matter.Engine): Matter.Body[] {
  const { minX, maxX, minY, maxY } = WORLD_BOUNDS;
  const thickness = 100;
  const walls = [
    // top
    Matter.Bodies.rectangle((minX + maxX) / 2, minY - thickness / 2, maxX - minX, thickness, {
      isStatic: true, restitution: RESTITUTION, label: 'wall-top',
    }),
    // bottom
    Matter.Bodies.rectangle((minX + maxX) / 2, maxY + thickness / 2, maxX - minX, thickness, {
      isStatic: true, restitution: RESTITUTION, label: 'wall-bottom',
    }),
    // left
    Matter.Bodies.rectangle(minX - thickness / 2, (minY + maxY) / 2, thickness, maxY - minY, {
      isStatic: true, restitution: RESTITUTION, label: 'wall-left',
    }),
    // right
    Matter.Bodies.rectangle(maxX + thickness / 2, (minY + maxY) / 2, thickness, maxY - minY, {
      isStatic: true, restitution: RESTITUTION, label: 'wall-right',
    }),
  ];
  Matter.Composite.add(engine.world, walls);
  return walls;
}

/** Create an icon physics body. */
export function createIconBody(id: string, x: number, y: number): Matter.Body {
  const body = Matter.Bodies.circle(x, y, ICON_RADIUS, {
    restitution: RESTITUTION,
    friction: 0.01,
    frictionAir: 0.08, // air drag (icons slow down naturally)
    density: 0.001,
    label: `icon-${id}`,
  });
  // Store the source position (where it wants to return to).
  (body as any).sourceX = x;
  (body as any).sourceY = y;
  (body as any).iconId = id;
  return body;
}

/** Apply a seek force toward the source position (the float-back behavior). */
export function seekToSource(body: Matter.Body, otherBodies: Matter.Body[]) {
  const sx = (body as any).sourceX;
  const sy = (body as any).sourceY;
  const dx = sx - body.position.x;
  const dy = sy - body.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Only seek if far from source + moving slowly.
  if (dist < 5 && Math.abs(body.velocity.x) < 0.5 && Math.abs(body.velocity.y) < 0.5) {
    // Snap to source when very close.
    Matter.Body.setVelocity(body, { x: 0, y: 0 });
    Matter.Body.setPosition(body, { x: sx, y: sy });
    return;
  }

  if (dist < 10) return; // close enough — let damping handle it

  // Seek force (normalized direction * force magnitude).
  const fx = (dx / dist) * SEEK_FORCE;
  const fy = (dy / dist) * SEEK_FORCE;

  // Avoidance: cast a ray ahead and steer around other icons.
  const speed = Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2);
  let avoidX = 0, avoidY = 0;
  if (speed > 0.1) {
    const dirX = body.velocity.x / speed;
    const dirY = body.velocity.y / speed;
    const lookAhead = 60;
    for (const other of otherBodies) {
      if (other === body || !other.label.startsWith('icon-')) continue;
      const odx = other.position.x - (body.position.x + dirX * lookAhead);
      const ody = other.position.y - (body.position.y + dirY * lookAhead);
      const odist = Math.sqrt(odx * odx + ody * ody);
      if (odist < ICON_RADIUS * 2.5 && odist > 0) {
        // Steer perpendicular to avoid.
        const strength = (1 - odist / (ICON_RADIUS * 2.5)) * 0.003;
        avoidX -= (odx / odist) * strength;
        avoidY -= (ody / odist) * strength;
      }
    }
  }

  Matter.Body.applyForce(body, body.position, { x: fx + avoidX, y: fy + avoidY });

  // Cap speed.
  const newSpeed = Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2);
  if (newSpeed > MAX_SPEED) {
    Matter.Body.setVelocity(body, {
      x: (body.velocity.x / newSpeed) * MAX_SPEED,
      y: (body.velocity.y / newSpeed) * MAX_SPEED,
    });
  }
}

/** Step the physics engine. */
export function stepPhysics(engine: Matter.Engine, deltaMs: number) {
  Matter.Engine.update(engine, deltaMs);
}
