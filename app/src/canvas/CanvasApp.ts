// CanvasApp — the PixiJS v8 application. Renders the bounded grid,
// chat icons (physics-driven), exec bubbles, name labels. Decoupled from
// React (reads from Zustand via non-reactive getState, writes on discrete
// events only).

import { Application, Container, Graphics, Text, TextStyle, Ticker } from 'pixi.js';
import Matter from 'matter-js';
import {
  createPhysics, createBoundaries, createIconBody, seekToSource,
  stepPhysics, WORLD_BOUNDS, ICON_RADIUS,
} from './physics';
import { hashHue, hueColor } from './names';
import type { ChatSession } from '../types';

export interface IconBody {
  sessionId: string;
  body: Matter.Body;
  hue: number;
  state: 'idle' | 'dragging' | 'streaming' | 'complete' | 'error';
  currentTool: string | null;
  lastPreview: string;
}

export interface CanvasCallbacks {
  onIconTap: (sessionId: string) => void;
  onIconDoubleTap: (sessionId: string) => void;
  onEmptyDoubleTap: (x: number, y: number) => void;
  onIconDragEnd: (sessionId: string, x: number, y: number) => void;
}

export class CanvasApp {
  app: Application;
  worldContainer: Container;
  gridGraphics: Graphics;
  iconContainer: Container;
  engine: Matter.Engine;
  icons: Map<string, IconBody> = new Map();
  camera = { x: 0, y: 0, zoom: 1 };
  callbacks: CanvasCallbacks;
  isDragging = false;
  draggedIcon: IconBody | null = null;
  dragOffset = { x: 0, y: 0 };
  lastTap = 0;
  lastTapTarget: string | null = null;

  constructor(callbacks: CanvasCallbacks) {
    this.callbacks = callbacks;
    this.app = new Application();
    this.worldContainer = new Container();
    this.gridGraphics = new Graphics();
    this.iconContainer = new Container();
    this.engine = createPhysics();
    createBoundaries(this.engine);
  }

  async init(canvas: HTMLCanvasElement) {
    await this.app.init({
      canvas,
      resizeTo: canvas.parentElement || window,
      background: 0x0a0a0b,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    this.worldContainer.addChild(this.gridGraphics);
    this.worldContainer.addChild(this.iconContainer);
    this.app.stage.addChild(this.worldContainer);

    this.drawGrid();
    this.setupInteraction();
    this.app.ticker.add(this.tick);
  }

  destroy() {
    this.app.ticker.remove(this.tick);
    this.app.destroy(true);
  }

  drawGrid() {
    const g = this.gridGraphics;
    g.clear();
    const { minX, maxX, minY, maxY } = WORLD_BOUNDS;
    const spacing = 40;
    const dotColor = 0x2a2a32;

    for (let x = minX; x <= maxX; x += spacing) {
      for (let y = minY; y <= maxY; y += spacing) {
        g.circle(x, y, 1.5).fill({ color: dotColor, alpha: 0.6 });
      }
    }
    // Boundary fade (soft rectangle at the edges).
    const fadeAlpha = 0.15;
    g.rect(minX, minY, maxX - minX, 80).fill({ color: 0x000000, alpha: fadeAlpha });
    g.rect(minX, maxY - 80, maxX - minX, 80).fill({ color: 0x000000, alpha: fadeAlpha });
    g.rect(minX, minY, 80, maxY - minY).fill({ color: 0x000000, alpha: fadeAlpha });
    g.rect(maxX - 80, minY, 80, maxY - minY).fill({ color: 0x000000, alpha: fadeAlpha });
  }

  setupInteraction() {
    // Pointer down — start drag or detect tap.
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointerdown', (e) => this.onPointerDown(e));
    this.app.stage.on('pointermove', (e) => this.onPointerMove(e));
    this.app.stage.on('pointerup', (e) => this.onPointerUp(e));
    this.app.stage.on('pointerupoutside', (e) => this.onPointerUp(e));

    // Wheel zoom.
    this.app.stage.on('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.zoom = Math.max(0.4, Math.min(2.5, this.camera.zoom * delta));
      this.updateCamera();
    });
  }

  onPointerDown(e: any) {
    const worldPos = this.screenToWorld(e.global.x, e.global.y);
    // Check if we hit an icon.
    const hit = this.findIconAt(worldPos.x, worldPos.y);
    const now = Date.now();
    const isDoubleTap = this.lastTapTarget === hit?.sessionId && now - this.lastTap < 300;

    if (hit) {
      if (isDoubleTap) {
        this.callbacks.onIconDoubleTap(hit.sessionId);
        this.lastTap = 0;
        this.lastTapTarget = null;
      } else {
        this.lastTap = now;
        this.lastTapTarget = hit.sessionId;
        // Start drag.
        this.draggedIcon = hit;
        this.isDragging = true;
        this.dragOffset = {
          x: hit.body.position.x - worldPos.x,
          y: hit.body.position.y - worldPos.y,
        };
        hit.state = 'dragging';
      }
    } else {
      // Empty space — check double-tap.
      if (now - this.lastTap < 300) {
        this.callbacks.onEmptyDoubleTap(worldPos.x, worldPos.y);
        this.lastTap = 0;
      } else {
        this.lastTap = now;
      }
    }
  }

  onPointerMove(e: any) {
    if (!this.isDragging || !this.draggedIcon) return;
    const worldPos = this.screenToWorld(e.global.x, e.global.y);
    const targetX = worldPos.x + this.dragOffset.x;
    const targetY = worldPos.y + this.dragOffset.y;
    // Set position directly (spring lag would be smoother but this is responsive).
    Matter.Body.setPosition(this.draggedIcon.body, { x: targetX, y: targetY });
    Matter.Body.setVelocity(this.draggedIcon.body, { x: 0, y: 0 });
  }

  onPointerUp(_e: any) {
    if (this.isDragging && this.draggedIcon) {
      // If the icon didn't move much, treat as a tap.
      const icon = this.draggedIcon;
      const dx = icon.body.position.x - (icon.body as any).sourceX;
      const dy = icon.body.position.y - (icon.body as any).sourceY;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
        this.callbacks.onIconTap(icon.sessionId);
      } else {
        // Update source to new position (icon stays where dropped).
        (icon.body as any).sourceX = icon.body.position.x;
        (icon.body as any).sourceY = icon.body.position.y;
        this.callbacks.onIconDragEnd(icon.sessionId, icon.body.position.x, icon.body.position.y);
      }
      icon.state = 'idle';
    }
    this.isDragging = false;
    this.draggedIcon = null;
  }

  findIconAt(x: number, y: number): IconBody | null {
    for (const icon of this.icons.values()) {
      const dx = icon.body.position.x - x;
      const dy = icon.body.position.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < ICON_RADIUS + 5) {
        return icon;
      }
    }
    return null;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.app.screen.width / 2) / this.camera.zoom + this.camera.x,
      y: (sy - this.app.screen.height / 2) / this.camera.zoom + this.camera.y,
    };
  }

  updateCamera() {
    this.worldContainer.scale.set(this.camera.zoom);
    this.worldContainer.x = this.app.screen.width / 2 - this.camera.x * this.camera.zoom;
    this.worldContainer.y = this.app.screen.height / 2 - this.camera.y * this.camera.zoom;
  }

  tick = (ticker: Ticker) => {
    const delta = ticker.deltaMS;
    // Step physics.
    stepPhysics(this.engine, delta);
    // Apply seek force to non-dragged icons.
    const allBodies = Array.from(this.icons.values()).map((i) => i.body);
    for (const icon of this.icons.values()) {
      if (icon.state !== 'dragging') {
        seekToSource(icon.body, allBodies);
      }
    }
    // Render icons.
    for (const icon of this.icons.values()) {
      this.renderIcon(icon);
    }
  };

  addIcon(session: ChatSession, x: number, y: number) {
    if (this.icons.has(session.ID)) return;
    const hue = hashHue(session.ID);
    const body = createIconBody(session.ID, x, y);
    Matter.Composite.add(this.engine.world, body);
    const icon: IconBody = {
      sessionId: session.ID,
      body,
      hue,
      state: 'idle',
      currentTool: null,
      lastPreview: '',
    };
    this.icons.set(session.ID, icon);

    // Create the Pixi graphics for this icon.
    const g = new Graphics();
    g.label = `icon-${session.ID}`;
    this.iconContainer.addChild(g);
    this.renderIcon(icon);
  }

  removeIcon(sessionId: string) {
    const icon = this.icons.get(sessionId);
    if (!icon) return;
    Matter.Composite.remove(this.engine.world, icon.body);
    const g = this.iconContainer.getChildByName(`icon-${sessionId}`);
    if (g) this.iconContainer.removeChild(g);
    this.icons.delete(sessionId);
  }

  renderIcon(icon: IconBody) {
    const g = this.iconContainer.getChildByName(`icon-${icon.sessionId}`) as Graphics;
    if (!g) return;
    g.clear();

    const x = icon.body.position.x;
    const y = icon.body.position.y;
    const hue = icon.hue;

    // Idle bob (visual only, not physics).
    const bobOffset = icon.state === 'idle' ? Math.sin(Date.now() / 1500 + hue) * 3 : 0;
    const renderY = y + bobOffset;

    // Glow (when streaming or complete).
    if (icon.state === 'streaming' || icon.state === 'complete') {
      const glowAlpha = icon.state === 'complete' ? 0.4 : 0.2 + Math.sin(Date.now() / 200) * 0.1;
      g.circle(x, renderY, ICON_RADIUS + 15).fill({ color: hueColor(hue, 70, 60), alpha: glowAlpha });
    }

    // Selection ring (when active/chat open — TODO: track active session).
    // g.circle(x, renderY, ICON_RADIUS + 4).stroke({ color: 0xa78bfa, width: 2, alpha: 0.8 });

    // The circle itself.
    const scale = icon.state === 'dragging' ? 1.1 : icon.state === 'complete' ? 1.1 : 1.0;
    g.circle(x, renderY, ICON_RADIUS * scale).fill({ color: hueColor(hue, 70, 60) });

    // Inner mark (a smaller dark circle — the "eye").
    g.circle(x, renderY, ICON_RADIUS * 0.4).fill({ color: 0x0a0a0b });

    // Name label (below).
    const name = icon.sessionId.slice(0, 8); // TODO: pass the real name
    const text = new Text({ text: name, style: new TextStyle({ fill: 0xe4e4e7, fontSize: 11, fontFamily: 'Inter' }) });
    text.anchor.set(0.5, 0);
    text.x = x;
    text.y = renderY + ICON_RADIUS + 6;
    text.alpha = 0.6;
    g.addChild(text);

    // Exec bubble (above).
    if (icon.currentTool) {
      const bubbleY = renderY - ICON_RADIUS - 20;
      g.roundRect(x - 16, bubbleY - 12, 32, 24, 6).fill({ color: 0x1c1c21, alpha: 0.9 });
      const toolText = new Text({ text: icon.currentTool.slice(0, 2), style: new TextStyle({ fill: 0xa78bfa, fontSize: 10 }) });
      toolText.anchor.set(0.5);
      toolText.x = x;
      toolText.y = bubbleY;
      g.addChild(toolText);
    }
  }

  updateIconState(sessionId: string, state: IconBody['state'], tool: string | null, preview: string) {
    const icon = this.icons.get(sessionId);
    if (!icon) return;
    icon.state = state;
    icon.currentTool = tool;
    icon.lastPreview = preview;
  }
}
