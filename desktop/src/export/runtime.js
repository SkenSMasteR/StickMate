(function (root) {
  "use strict";

  const TAU = Math.PI * 2;

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function layerLength(layer) {
    if (!layer.folder) {
      return layer.length;
    }
    let length = 1;
    for (const child of layer.children) {
      length = Math.max(length, layerLength(child));
    }
    return length;
  }

  function sceneLength(scene) {
    let length = 1;
    for (const layer of scene.layers) {
      length = Math.max(length, layerLength(layer));
    }
    return length;
  }

  function heldKey(layer, frame) {
    let found = null;
    for (const key of layer.keys) {
      if (key.frame <= frame) {
        found = key;
      }
    }
    return found;
  }

  const LINEAR_EASING = { x1: 0, y1: 0, x2: 1, y2: 1 };

  function cubicValue(p1, p2, u) {
    const inv = 1 - u;
    return 3 * inv * inv * u * p1 + 3 * inv * u * u * p2 + u * u * u;
  }

  function cubicSlope(p1, p2, u) {
    const inv = 1 - u;
    return 3 * inv * inv * p1 + 6 * inv * u * (p2 - p1) + 3 * u * u * (1 - p2);
  }

  function curveUnit(x1, x2, target) {
    let u = target;
    for (let steps = 0; steps < 8; steps += 1) {
      const error = cubicValue(x1, x2, u) - target;
      if (Math.abs(error) <= 1e-7) {
        return u;
      }
      const slope = cubicSlope(x1, x2, u);
      if (Math.abs(slope) <= 1e-7) {
        break;
      }
      const next = u - error / slope;
      if (next <= 0 || next >= 1) {
        break;
      }
      u = next;
    }
    let low = 0;
    let high = 1;
    for (let index = 0; index < 32; index += 1) {
      const middle = (low + high) / 2;
      if (cubicValue(x1, x2, middle) < target) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return (low + high) / 2;
  }

  function easeProgress(t, easing) {
    if (t <= 0) {
      return 0;
    }
    if (t >= 1) {
      return 1;
    }
    const curve = easing || LINEAR_EASING;
    if (curve.x1 === curve.y1 && curve.x2 === curve.y2) {
      return t;
    }
    return cubicValue(curve.y1, curve.y2, curveUnit(curve.x1, curve.x2, t));
  }

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  function mixPoint(a, b, t) {
    return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
  }

  function mixBytes(value) {
    if (typeof value !== "string" || value.charAt(0) !== "#") {
      return null;
    }
    const hex = value.slice(1);
    if (!/^[0-9a-fA-F]{3}$/.test(hex) && !/^[0-9a-fA-F]{6}$/.test(hex)) {
      return null;
    }
    if (hex.length === 3) {
      return [
        parseInt(hex.charAt(0), 16) * 17,
        parseInt(hex.charAt(1), 16) * 17,
        parseInt(hex.charAt(2), 16) * 17
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ];
  }

  function mixColor(a, b, t) {
    const from = mixBytes(a);
    const to = mixBytes(b);
    if (!from || !to) {
      return a;
    }
    let out = "#";
    for (let index = 0; index < 3; index += 1) {
      out += Math.floor(mix(from[index], to[index], t) + 0.5)
        .toString(16)
        .padStart(2, "0");
    }
    return out;
  }

  function mixHandle(a, b, aPoint, bPoint, t) {
    if (!a && !b) {
      return null;
    }
    return mixPoint(a || aPoint, b || bPoint, t);
  }

  function mixAffine(a, b, t) {
    const names = ["a", "b", "c", "d", "e", "f"];
    const out = {};
    for (const name of names) {
      out[name] = mix(a[name], b[name], t);
    }
    return out;
  }

  function gradientOf(shape) {
    return shape.gradient || null;
  }

  function mixStops(a, b, t) {
    return a.map((stop, index) => ({
      offset: mix(stop.offset, b[index].offset, t),
      color: mixColor(stop.color, b[index].color, t)
    }));
  }

  function mixGradient(a, b, t) {
    if (a && b && a.kind === b.kind && a.stops.length === b.stops.length) {
      const stops = mixStops(a.stops, b.stops, t);
      return a.kind === "linear"
        ? { kind: "linear", angle: mix(a.angle, b.angle, t), stops: stops }
        : { kind: "radial", stops: stops };
    }
    return a || null;
  }

  function gradientsMixable(a, b) {
    if (!a && !b) {
      return true;
    }
    return !!a && !!b && a.kind === b.kind && a.stops.length === b.stops.length;
  }

  function gradientBox(shape) {
    if (shape.kind === "Path") {
      var xs = [];
      var ys = [];
      for (var index = 0; index < shape.nodes.length; index += 1) {
        var node = shape.nodes[index];
        xs.push(node.point.x);
        ys.push(node.point.y);
        if (node.handle_in) {
          xs.push(node.handle_in.x);
          ys.push(node.handle_in.y);
        }
        if (node.handle_out) {
          xs.push(node.handle_out.x);
          ys.push(node.handle_out.y);
        }
      }
      var left = Math.min.apply(null, xs);
      var top = Math.min.apply(null, ys);
      return {
        x: left,
        y: top,
        w: Math.max.apply(null, xs) - left,
        h: Math.max.apply(null, ys) - top
      };
    }
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }

  function gradientGeometry(box, gradient) {
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    if (gradient.kind === "radial") {
      return [cx, cy, cx, cy, Math.hypot(box.w / 2, box.h / 2)];
    }
    var rad = (gradient.angle * Math.PI) / 180;
    var dx = Math.cos(rad);
    var dy = Math.sin(rad);
    var half = (Math.abs(dx) * box.w + Math.abs(dy) * box.h) / 2;
    return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, 0];
  }

  function ink(value) {
    return value === "none" || value === "" ? "transparent" : value;
  }

  function fillStyle(ctx, shape) {
    var gradient = gradientOf(shape);
    if (!gradient) {
      return ink(shape.fill);
    }
    var parts = gradientGeometry(gradientBox(shape), gradient);
    var paint =
      gradient.kind === "linear"
        ? ctx.createLinearGradient(parts[0], parts[1], parts[2], parts[3])
        : ctx.createRadialGradient(parts[0], parts[1], 0, parts[2], parts[3], parts[4]);
    for (var index = 0; index < gradient.stops.length; index += 1) {
      var stop = gradient.stops[index];
      paint.addColorStop(stop.offset, stop.color);
    }
    return paint;
  }

  function mixable(a, b) {
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === "Rect" || a.kind === "Ellipse") {
      return gradientsMixable(gradientOf(a), gradientOf(b));
    }
    if (a.kind === "Text" || a.kind === "Bitmap") {
      return true;
    }
    if (a.kind === "Polygon") {
      return a.sides === b.sides && gradientsMixable(gradientOf(a), gradientOf(b));
    }
    if (a.kind === "Stroke") {
      return a.points.length === b.points.length && a.points.length > 1;
    }
    if (a.kind === "Path") {
      return (
        a.closed === b.closed &&
        a.nodes.length === b.nodes.length &&
        a.nodes.length > 1 &&
        gradientsMixable(gradientOf(a), gradientOf(b))
      );
    }
    if (a.kind === "Group") {
      return (
        a.children.length > 0 &&
        a.children.length === b.children.length &&
        a.children.every((child, index) => mixable(child, b.children[index]))
      );
    }
    if (a.kind === "Figure") {
      return (
        a.figure.bones.length === b.figure.bones.length &&
        a.figure.bones.every((bone, index) => {
          const other = b.figure.bones[index];
          return (
            bone.parent === other.parent &&
            bone.art.length === other.art.length &&
            bone.art.every((child, childIndex) => mixable(child, other.art[childIndex]))
          );
        })
      );
    }
    return false;
  }

  function mixShape(a, b, t) {
    if (t <= 0) {
      return a;
    }
    if (t >= 1) {
      return b;
    }
    if (a.kind !== b.kind) {
      return a;
    }
    if (a.kind === "Group") {
      if (!mixable(a, b)) {
        return a;
      }
      return {
        kind: "Group",
        children: a.children.map((child, index) => mixShape(child, b.children[index], t))
      };
    }
    if (a.kind === "Figure") {
      if (!mixable(a, b)) {
        return a;
      }
      return {
        kind: "Figure",
        figure: {
          x: mix(a.figure.x, b.figure.x, t),
          y: mix(a.figure.y, b.figure.y, t),
          rotation: mix(a.figure.rotation, b.figure.rotation, t),
          bones: a.figure.bones.map((bone, index) => {
            const other = b.figure.bones[index];
            return {
              parent: bone.parent,
              anchor: mixPoint(bone.anchor, other.anchor, t),
              length: mix(bone.length, other.length, t),
              twist: mix(bone.twist, other.twist, t),
              width: mix(bone.width, other.width, t),
              color: mixColor(bone.color, other.color, t),
              art: bone.art.map((child, childIndex) => mixShape(child, other.art[childIndex], t))
            };
          })
        }
      };
    }
    if (a.kind === "Rect" || a.kind === "Ellipse" || a.kind === "Polygon") {
      if (a.kind === "Polygon" && a.sides !== b.sides) {
        return a;
      }
      const box = {
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
        w: mix(a.w, b.w, t),
        h: mix(a.h, b.h, t),
        fill: mixColor(a.fill, b.fill, t),
        stroke: mixColor(a.stroke, b.stroke, t),
        width: mix(a.width, b.width, t),
        gradient: mixGradient(gradientOf(a), gradientOf(b), t)
      };
      if (a.kind === "Polygon") {
        box.sides = a.sides;
      }
      return Object.assign({ kind: a.kind }, box);
    }
    if (a.kind === "Stroke") {
      if (a.points.length !== b.points.length || a.points.length < 2) {
        return a;
      }
      return {
        kind: "Stroke",
        points: a.points.map((point, index) => mixPoint(point, b.points[index], t)),
        color: mixColor(a.color, b.color, t),
        width: mix(a.width, b.width, t)
      };
    }
    if (a.kind === "Path") {
      if (
        a.closed !== b.closed ||
        a.nodes.length !== b.nodes.length ||
        a.nodes.length < 2
      ) {
        return a;
      }
      return {
        kind: "Path",
        nodes: a.nodes.map((node, index) => {
          const other = b.nodes[index];
          return {
            point: mixPoint(node.point, other.point, t),
            handle_in: mixHandle(node.handle_in, other.handle_in, node.point, other.point, t),
            handle_out: mixHandle(
              node.handle_out,
              other.handle_out,
              node.point,
              other.point,
              t
            )
          };
        }),
        closed: a.closed,
        fill: mixColor(a.fill, b.fill, t),
        stroke: mixColor(a.stroke, b.stroke, t),
        width: mix(a.width, b.width, t),
        gradient: mixGradient(gradientOf(a), gradientOf(b), t)
      };
    }
    if (a.kind === "Text") {
      return {
        kind: "Text",
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
        text: a.text,
        size: mix(a.size, b.size, t),
        family: a.family,
        color: mixColor(a.color, b.color, t),
        spacing: mix(a.spacing || 0, b.spacing || 0, t),
        leading: mix(a.leading || TEXT_LEADING, b.leading || TEXT_LEADING, t),
        align: a.align || "left",
        matrix:
          a.matrix && b.matrix
            ? mixAffine(a.matrix, b.matrix, t)
            : a.matrix || b.matrix || null
      };
    }
    if (a.kind === "Bitmap") {
      return {
        kind: "Bitmap",
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
        w: mix(a.w, b.w, t),
        h: mix(a.h, b.h, t),
        source: a.source,
        matrix:
          a.matrix && b.matrix
            ? mixAffine(a.matrix, b.matrix, t)
            : a.matrix || b.matrix || null
      };
    }
    return a;
  }

  const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  function applyAffine(matrix, point) {
    return {
      x: matrix.a * point.x + matrix.c * point.y + matrix.e,
      y: matrix.b * point.x + matrix.d * point.y + matrix.f
    };
  }

  function composeAffine(outer, inner) {
    return {
      a: outer.a * inner.a + outer.c * inner.b,
      b: outer.b * inner.a + outer.d * inner.b,
      c: outer.a * inner.c + outer.c * inner.d,
      d: outer.b * inner.c + outer.d * inner.d,
      e: outer.a * inner.e + outer.c * inner.f + outer.e,
      f: outer.b * inner.e + outer.d * inner.f + outer.f
    };
  }

  function affineFrom(pivot, dx, dy, sx, sy, rotation) {
    const angle = (rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    return {
      a: a,
      b: b,
      c: c,
      d: d,
      e: pivot.x - a * pivot.x - c * pivot.y + dx,
      f: pivot.y - b * pivot.x - d * pivot.y + dy
    };
  }

  function rotatedGradient(gradient, rotation) {
    if (!gradient) {
      return null;
    }
    return gradient.kind === "linear"
      ? { kind: "linear", angle: gradient.angle + rotation, stops: gradient.stops }
      : gradient;
  }

  function cornersPath(corners, matrix, fill, stroke, width, gradient) {
    return {
      kind: "Path",
      nodes: corners.map(function (point) {
        return { point: applyAffine(matrix, point), handle_in: null, handle_out: null };
      }),
      closed: true,
      fill: fill,
      stroke: stroke,
      width: width,
      gradient: gradient
    };
  }

  function transformShape(shape, matrix, sx, sy, rotation) {
    if (shape.kind === "Group") {
      return {
        kind: "Group",
        children: shape.children.map(function (child) {
          return transformShape(child, matrix, sx, sy, rotation);
        })
      };
    }
    if (shape.kind === "Figure") {
      if (Math.abs(sx - sy) > 0.0001) {
        throw new Error("a figure cannot be stretched in one direction");
      }
      const scale = Math.sqrt(matrix.a * matrix.d - matrix.b * matrix.c);
      const grown = { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
      const moved = applyAffine(matrix, { x: shape.figure.x, y: shape.figure.y });
      return {
        kind: "Figure",
        figure: {
          x: moved.x,
          y: moved.y,
          rotation: shape.figure.rotation + rotation,
          bones: shape.figure.bones.map(function (bone) {
            return {
              parent: bone.parent,
              anchor: { x: bone.anchor.x * scale, y: bone.anchor.y * scale },
              length: bone.length * scale,
              twist: bone.twist,
              width: bone.width * scale,
              color: bone.color,
              art: bone.art.map(function (item) {
                return transformShape(item, grown, scale, scale, 0);
              })
            };
          })
        }
      };
    }
    if (shape.kind === "Instance") {
      return {
        ...shape,
        matrix: composeAffine(matrix, shape.matrix || IDENTITY_MATRIX)
      };
    }
    if (shape.kind === "Stroke") {
      return {
        ...shape,
        points: shape.points.map(function (point) {
          return applyAffine(matrix, point);
        })
      };
    }
    if (shape.kind === "Path") {
      return {
        ...shape,
        nodes: shape.nodes.map(function (node) {
          return {
            point: applyAffine(matrix, node.point),
            handle_in: node.handle_in ? applyAffine(matrix, node.handle_in) : null,
            handle_out: node.handle_out ? applyAffine(matrix, node.handle_out) : null
          };
        })
      };
    }
    if (shape.kind === "Text") {
      if (!shape.matrix && rotation === 0 && sx === sy) {
        const at = applyAffine(matrix, { x: shape.x, y: shape.y });
        return {
          ...shape,
          x: at.x,
          y: at.y,
          size: shape.size * sx,
          spacing: (shape.spacing || 0) * sx
        };
      }
      return {
        ...shape,
        matrix: shape.matrix ? composeAffine(matrix, shape.matrix) : matrix
      };
    }
    if (shape.kind === "Bitmap") {
      if (!shape.matrix && rotation === 0 && sx === sy) {
        const scale = Math.sqrt(matrix.a * matrix.d - matrix.b * matrix.c);
        const at = applyAffine(matrix, { x: shape.x, y: shape.y });
        return {
          kind: "Bitmap",
          x: at.x,
          y: at.y,
          w: shape.w * scale,
          h: shape.h * scale,
          source: shape.source
        };
      }
      return {
        ...shape,
        matrix: shape.matrix ? composeAffine(matrix, shape.matrix) : matrix
      };
    }
    if (shape.kind === "Ellipse" && rotation !== 0) {
      if (rotation % 90 !== 0) {
        throw new Error("ellipse cannot be rotated");
      }
      const center = applyAffine(matrix, {
        x: shape.x + shape.w / 2,
        y: shape.y + shape.h / 2
      });
      const odd = Math.abs(Math.trunc(rotation / 90)) % 2 === 1;
      const nw = odd ? shape.h * sy : shape.w * sx;
      const nh = odd ? shape.w * sx : shape.h * sy;
      return { ...shape, x: center.x - nw / 2, y: center.y - nh / 2, w: nw, h: nh };
    }
    if (shape.kind === "Rect" && rotation !== 0) {
      return cornersPath(
        [
          { x: shape.x, y: shape.y },
          { x: shape.x + shape.w, y: shape.y },
          { x: shape.x + shape.w, y: shape.y + shape.h },
          { x: shape.x, y: shape.y + shape.h }
        ],
        matrix,
        shape.fill,
        shape.stroke,
        shape.width,
        rotatedGradient(shape.gradient, rotation)
      );
    }
    if (shape.kind === "Polygon" && rotation !== 0) {
      return cornersPath(
        polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides),
        matrix,
        shape.fill,
        shape.stroke,
        shape.width,
        rotatedGradient(shape.gradient, rotation)
      );
    }
    const corner = applyAffine(matrix, { x: shape.x, y: shape.y });
    return { ...shape, x: corner.x, y: corner.y, w: shape.w * sx, h: shape.h * sy };
  }

  function ellipseNodes(x, y, w, h) {
    const step = (Math.PI * 2) / 16;
    const k = (4 / 3) * Math.tan(step / 4);
    const nodes = [];
    for (let index = 0; index < 16; index += 1) {
      const angle = index * step;
      const point = {
        x: x + w / 2 + (w / 2) * Math.cos(angle),
        y: y + h / 2 + (h / 2) * Math.sin(angle)
      };
      const dx = (-w / 2) * Math.sin(angle) * k;
      const dy = (h / 2) * Math.cos(angle) * k;
      nodes.push({
        point: point,
        handle_in: { x: point.x - dx, y: point.y - dy },
        handle_out: { x: point.x + dx, y: point.y + dy }
      });
    }
    return nodes;
  }

  function curvedEllipse(shape, rotation) {
    if (shape.kind === "Group") {
      return {
        kind: "Group",
        children: shape.children.map(function (child) {
          return curvedEllipse(child, rotation);
        })
      };
    }
    if (shape.kind === "Ellipse" && rotation % 90 !== 0) {
      return {
        kind: "Path",
        nodes: ellipseNodes(shape.x, shape.y, shape.w, shape.h),
        closed: true,
        fill: shape.fill,
        stroke: shape.stroke,
        width: shape.width,
        gradient: rotatedGradient(shape.gradient, rotation)
      };
    }
    return JSON.parse(JSON.stringify(shape));
  }

  function bakeShape(shape, matrix) {
    const sx = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
    const sy = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);
    const rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
    try {
      return transformShape(curvedEllipse(shape, rotation), matrix, sx, sy, rotation);
    } catch (error) {
      return null;
    }
  }

  function layerMatrix(place) {
    return affineFrom({ x: 0, y: 0 }, place.x, place.y, place.scale, place.scale, place.rotation);
  }

  function colorAlpha(value) {
    const digits = String(value).trim().replace(/^#/, "").toLowerCase();
    if (/[^0-9a-f]/.test(digits)) {
      return ["#000000", 1];
    }
    if (digits.length === 3 || digits.length === 4) {
      const nibble = function (index) {
        return (parseInt(digits.charAt(index), 16) * 17).toString(16).padStart(2, "0");
      };
      const alpha = digits.length === 4 ? parseInt(nibble(3), 16) / 255 : 1;
      return ["#" + nibble(0) + nibble(1) + nibble(2), alpha];
    }
    if (digits.length === 6 || digits.length === 8) {
      const alpha = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
      return ["#" + digits.slice(0, 6), alpha];
    }
    return ["#000000", 1];
  }

  function shadeColor(value, opacity) {
    if (opacity >= 0.999 || String(value).charAt(0) !== "#") {
      return value;
    }
    const parts = colorAlpha(value);
    const byte = Math.round(parts[1] * clamp(opacity, 0, 1) * 255);
    return parts[0] + byte.toString(16).padStart(2, "0");
  }

  function tintShape(shape, opacity) {
    const out = JSON.parse(JSON.stringify(shape));
    if (opacity >= 0.999) {
      return out;
    }
    if (out.kind === "Stroke" || out.kind === "Text") {
      out.color = shadeColor(out.color, opacity);
      return out;
    }
    if (out.kind === "Rect" || out.kind === "Ellipse" || out.kind === "Polygon" || out.kind === "Path") {
      out.fill = shadeColor(out.fill, opacity);
      out.stroke = shadeColor(out.stroke, opacity);
      if (out.gradient) {
        for (const stop of out.gradient.stops) {
          stop.color = shadeColor(stop.color, opacity);
        }
      }
      return out;
    }
    if (out.kind === "Group") {
      out.children = out.children.map(function (child) {
        return tintShape(child, opacity);
      });
      return out;
    }
    if (out.kind === "Figure") {
      for (const bone of out.figure.bones) {
        bone.color = shadeColor(bone.color, opacity);
        bone.art = bone.art.map(function (item) {
          return tintShape(item, opacity);
        });
      }
      return out;
    }
    return out;
  }

  function symbolLength(symbol) {
    let length = 1;
    for (const layer of symbol.layers) {
      length = Math.max(length, layer.length);
    }
    return length;
  }

  function heldFrame(layer, frame) {
    const key = heldKey(layer, frame);
    return key ? key.frame : frame;
  }

  function localFrame(length, looping, first, elapsed) {
    if (looping === "singleFrame") {
      return first;
    }
    if (looping === "playOnce") {
      return Math.min(first + elapsed, Math.max(0, length - 1));
    }
    if (first >= length) {
      return first;
    }
    return first + (elapsed % (length - first));
  }

  function expandShapes(shapes, elapsed, symbols, book) {
    const out = [];
    for (const shape of shapes) {
      out.push(...expandShape(shape, elapsed, symbols, book));
    }
    return out;
  }

  function expandShape(shape, elapsed, symbols, book) {
    if (shape.kind === "Group") {
      return [
        { kind: "Group", children: expandShapes(shape.children, elapsed, symbols, book) }
      ];
    }
    if (shape.kind !== "Instance") {
      return [JSON.parse(JSON.stringify(shape))];
    }
    if (!shape.visible) {
      return [];
    }
    let index = -1;
    for (let position = 0; position < symbols.length; position += 1) {
      if (symbols[position].id === shape.symbol) {
        index = position;
        break;
      }
    }
    if (index < 0) {
      return [JSON.parse(JSON.stringify(shape))];
    }
    const local = localFrame(
      symbolLength(symbols[index]),
      shape.looping,
      shape.firstFrame,
      elapsed
    );
    const matrix = shape.matrix || IDENTITY_MATRIX;
    return [
      {
        kind: "Group",
        children: symbolShapes(index, local, symbols, book).map(function (item) {
          const baked = bakeShape(item, matrix);
          return baked ? baked : item;
        })
      }
    ];
  }

  function symbolShapes(index, frame, symbols, book) {
    const symbol = symbols[index];
    if (!symbol) {
      return [];
    }
    const key = symbol.id + ":" + frame;
    if (book.has(key)) {
      return book.get(key).slice();
    }
    book.set(key, []);
    const out = symbolLayers(symbol.layers, frame, 1, symbols, book);
    book.set(key, out);
    return out.slice();
  }

  function symbolLayers(layers, frame, opacity, symbols, book) {
    const out = [];
    for (const layer of layers) {
      if (layer.folder) {
        out.push(...symbolLayers(layer.children, frame, opacity * layer.opacity, symbols, book));
        continue;
      }
      const item = evaluateLayer(layer, frame);
      if (!item) {
        continue;
      }
      const ink = clamp(opacity * item.opacity, 0, 1);
      const elapsed = Math.max(0, frame - heldFrame(layer, frame));
      const place = layerMatrix(item.transform);
      for (const shape of expandShapes(item.shapes, elapsed, symbols, book)) {
        const baked = bakeShape(shape, place);
        out.push(tintShape(baked ? baked : shape, ink));
      }
    }
    return out;
  }

  function evaluateLayer(layer, frame) {
    if (!layer.visible || frame >= layer.length) {
      return null;
    }
    const key = heldKey(layer, frame);
    if (!key) {
      return null;
    }
    let transform = { ...key.transform };
    let shapes = key.shapes;
    if (key.tween) {
      const next = layer.keys[layer.keys.indexOf(key) + 1];
      if (next) {
        const span = next.frame - key.frame;
        if (span > 0) {
          const t = easeProgress(clamp((frame - key.frame) / span, 0, 1), key.easing);
          transform = {
            x: transform.x + (next.transform.x - transform.x) * t,
            y: transform.y + (next.transform.y - transform.y) * t,
            rotation:
              transform.rotation + (next.transform.rotation - transform.rotation) * t,
            scale: transform.scale + (next.transform.scale - transform.scale) * t,
            opacity: transform.opacity + (next.transform.opacity - transform.opacity) * t
          };
          shapes = key.shapes.map((shape, position) => {
            const other = next.shapes[position];
            return other ? mixShape(shape, other, t) : shape;
          });
        }
      }
    }
    return {
      folder: false,
      opacity: clamp(layer.opacity * transform.opacity, 0, 1),
      blend: layer.blend,
      effects: layer.effects,
      mask: null,
      transform,
      shapes,
      children: []
    };
  }

  function evaluateFolder(folder, frame, symbols, book) {
    if (!folder.visible) {
      return null;
    }
    const children = evaluateLayers(folder.children, frame, symbols, book);
    if (children.length === 0) {
      return null;
    }
    return {
      folder: true,
      opacity: clamp(folder.opacity, 0, 1),
      blend: folder.blend,
      effects: folder.effects,
      mask: null,
      transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
      shapes: [],
      children
    };
  }

  function maskFrom(provider, frame, symbols, book) {
    if (!provider || provider.folder || !provider.visible || frame >= provider.length) {
      return null;
    }
    const evaluated = evaluateLayer(provider, frame);
    if (!evaluated) {
      return null;
    }
    const elapsed = Math.max(0, frame - heldFrame(provider, frame));
    return {
      transform: evaluated.transform,
      shapes: expandShapes(evaluated.shapes, elapsed, symbols, book)
    };
  }

  function evaluateLayers(layers, frame, symbols, book) {
    const evaluated = [];
    layers.forEach((layer, position) => {
      const result = layer.folder
        ? evaluateFolder(layer, frame, symbols, book)
        : evaluateLayer(layer, frame);
      if (!result) {
        return;
      }
      if (!layer.folder) {
        const elapsed = Math.max(0, frame - heldFrame(layer, frame));
        result.shapes = expandShapes(result.shapes, elapsed, symbols, book);
      }
      if (layer.masked && position > 0) {
        result.mask = maskFrom(layers[position - 1], frame, symbols, book);
      }
      evaluated.push(result);
    });
    return evaluated;
  }

  function filterOf(effects) {
    if (!effects || effects.length === 0) {
      return "none";
    }
    return effects
      .map(function (effect) {
        return effect.kind === "blur"
          ? "blur(" + effect.radius + "px)"
          : "drop-shadow(" + effect.x + "px " + effect.y + "px " + effect.blur + "px " + effect.color + ")";
      })
      .join(" ");
  }

  function compositeOf(blend) {
    return blend && blend !== "normal" ? blend : "source-over";
  }

  function polygonVertices(x, y, w, h, sides) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const step = TAU / sides;
    const points = [];
    for (let index = 0; index < sides; index += 1) {
      const angle = -Math.PI / 2 + index * step;
      points.push({ x: cx + (w / 2) * Math.cos(angle), y: cy + (h / 2) * Math.sin(angle) });
    }
    return points;
  }

  const TEXT_ADVANCE = 0.6;
  const TEXT_LEADING = 1.2;

  function textLineWidth(line, size, spacing) {
    const count = [...line].length;
    if (count === 0) {
      return 0;
    }
    return Math.max(0, count * size * TEXT_ADVANCE + spacing * (count - 1));
  }

  function textBlockWidth(text, size, spacing) {
    return Math.max(...text.split("\n").map((line) => textLineWidth(line, size, spacing)), 0);
  }

  function textLineOffset(width, block, align) {
    if (align === "center") {
      return (block - width) / 2;
    }
    if (align === "right") {
      return block - width;
    }
    return 0;
  }

  function textLines(shape) {
    const spacing = shape.spacing || 0;
    const leading = shape.leading || TEXT_LEADING;
    const align = shape.align || "left";
    const block = textBlockWidth(shape.text, shape.size, spacing);
    const lineHeight = shape.size * leading;
    return shape.text.split("\n").map((text, index) => ({
      text,
      x: shape.x + textLineOffset(textLineWidth(text, shape.size, spacing), block, align),
      y: shape.y + index * lineHeight
    }));
  }

  function figurePlaces(figure) {
    const root = { x: figure.x, y: figure.y };
    const out = [];
    for (const bone of figure.bones) {
      const parent = bone.parent === null || bone.parent === undefined ? null : out[bone.parent];
      const frame = parent ? parent.tip : root;
      const parentAngle = parent ? parent.angle : (figure.rotation * Math.PI) / 180;
      const angle = parentAngle + (bone.twist * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const base = {
        x: frame.x + bone.anchor.x * cos - bone.anchor.y * sin,
        y: frame.y + bone.anchor.x * sin + bone.anchor.y * cos
      };
      out.push({
        base: base,
        tip: { x: base.x + bone.length * cos, y: base.y + bone.length * sin },
        angle: angle
      });
    }
    return out;
  }

  const images = new Map();

  function imageFor(source) {
    const found = images.get(source);
    if (found) {
      return found;
    }
    const image = new Image();
    image.src = source;
    images.set(source, image);
    return image;
  }

  function bitmapSources(shape, out) {
    if (shape.kind === "Bitmap") {
      out.push(shape.source);
    } else if (shape.kind === "Group") {
      for (const child of shape.children) {
        bitmapSources(child, out);
      }
    } else if (shape.kind === "Figure") {
      for (const bone of shape.figure.bones) {
        for (const child of bone.art) {
          bitmapSources(child, out);
        }
      }
    }
    return out;
  }

  function projectSources(project) {
    const sources = [];
    for (const scene of project.scenes) {
      for (const layer of scene.layers) {
        collectLayerSources(layer, sources);
      }
    }
    for (const symbol of project.symbols || []) {
      for (const layer of symbol.layers) {
        collectLayerSources(layer, sources);
      }
    }
    return sources;
  }

  function collectLayerSources(layer, out) {
    if (layer.folder) {
      for (const child of layer.children) {
        collectLayerSources(child, out);
      }
      return out;
    }
    for (const key of layer.keys) {
      for (const shape of key.shapes) {
        bitmapSources(shape, out);
      }
    }
    return out;
  }

  function drawShape(ctx, shape) {
    if (shape.kind === "Group") {
      for (const child of shape.children) {
        drawShape(ctx, child);
      }
      return;
    }
    if (shape.kind === "Instance") {
      return;
    }
    if (shape.kind === "Figure") {
      const places = figurePlaces(shape.figure);
      for (let index = 0; index < shape.figure.bones.length; index += 1) {
        const bone = shape.figure.bones[index];
        const place = places[index];
        ctx.save();
        ctx.translate(place.base.x, place.base.y);
        ctx.rotate(place.angle);
        if (bone.length > 0) {
          ctx.strokeStyle = ink(bone.color);
          ctx.lineWidth = Math.max(bone.width, 1);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(bone.length, 0);
          ctx.stroke();
        }
        for (const child of bone.art) {
          drawShape(ctx, child);
        }
        ctx.restore();
      }
      return;
    }
    if (shape.kind === "Stroke") {
      if (shape.points.length < 2) {
        return;
      }
      ctx.strokeStyle = ink(shape.color);
      ctx.lineWidth = shape.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let index = 1; index < shape.points.length; index += 1) {
        ctx.lineTo(shape.points[index].x, shape.points[index].y);
      }
      ctx.stroke();
      return;
    }
    if (shape.kind === "Text") {
      ctx.save();
      if (shape.matrix) {
        const m = shape.matrix;
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      }
      ctx.fillStyle = ink(shape.color);
      ctx.font = shape.size + "px " + shape.family;
      ctx.textBaseline = "hanging";
      ctx.letterSpacing = (shape.spacing || 0) + "px";
      for (const line of textLines(shape)) {
        ctx.fillText(line.text, line.x, line.y);
      }
      ctx.restore();
      return;
    }
    if (shape.kind === "Path") {
      const nodes = shape.nodes;
      if (nodes.length === 0) {
        return;
      }
      if (shape.closed) {
        ctx.fillStyle = fillStyle(ctx, shape);
      }
      ctx.strokeStyle = ink(shape.stroke);
      ctx.lineWidth = shape.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(nodes[0].point.x, nodes[0].point.y);
      const segments = shape.closed ? nodes.length : nodes.length - 1;
      for (let index = 0; index < segments; index += 1) {
        const a = nodes[index];
        const b = nodes[(index + 1) % nodes.length];
        const p1 = a.handle_out || a.point;
        const p2 = b.handle_in || b.point;
        ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, b.point.x, b.point.y);
      }
      if (shape.closed) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
      return;
    }
    if (shape.kind === "Bitmap") {
      const image = imageFor(shape.source);
      if (!image.complete) {
        return;
      }
      ctx.save();
      if (shape.matrix) {
        const m = shape.matrix;
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      }
      ctx.drawImage(image, shape.x, shape.y, shape.w, shape.h);
      ctx.restore();
      return;
    }
    ctx.fillStyle = fillStyle(ctx, shape);
    ctx.strokeStyle = ink(shape.stroke);
    ctx.lineWidth = shape.width;
    ctx.lineCap = "butt";
    ctx.lineJoin = shape.kind === "Polygon" ? "round" : "miter";
    ctx.beginPath();
    if (shape.kind === "Rect") {
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
    } else if (shape.kind === "Ellipse") {
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, shape.w / 2, shape.h / 2, 0, 0, TAU);
    } else {
      const points = polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides);
      ctx.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        ctx.lineTo(points[index].x, points[index].y);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }

  function load(project) {
    const scenes = project.scenes;
    const scale = project.scale;
    const width = project.width;
    const height = project.height;
    const startFrame = project.startFrame;
    const endFrame = project.endFrame;
    let frameCount = 0;
    if (endFrame === null) {
      for (const scene of scenes) {
        frameCount += sceneLength(scene);
      }
    } else {
      frameCount = endFrame - startFrame + 1;
    }
    let frame = 0;
    let playing = false;
    let loop = project.loop;
    let timer = null;
    let canvas = null;
    let ctx = null;
    let buffer = null;
    let bctx = null;
    let scratch = null;
    let sctx = null;
    const surfaces = [];
    for (const source of projectSources(project)) {
      const image = imageFor(source);
      if (!image.complete) {
        image.addEventListener("load", render);
      }
    }

    function evaluate(at) {
      let scene = scenes[0];
      let local = at;
      if (endFrame !== null) {
        local = startFrame + at;
      } else {
        let index = 0;
        while (index < scenes.length - 1 && local >= sceneLength(scenes[index])) {
          local -= sceneLength(scenes[index]);
          index += 1;
        }
        scene = scenes[index];
      }
      return evaluateLayers(scene.layers, local, project.symbols || [], new Map());
    }

    function surface(depth) {
      let entry = surfaces[depth];
      if (!entry) {
        const holder = document.createElement("canvas");
        holder.width = width;
        holder.height = height;
        entry = { canvas: holder, ctx: holder.getContext("2d") };
        surfaces[depth] = entry;
      }
      return entry;
    }

    function composite(target, layer, source) {
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = layer.opacity;
      target.globalCompositeOperation = compositeOf(layer.blend);
      target.filter = filterOf(layer.effects);
      target.drawImage(source, 0, 0);
      target.filter = "none";
      target.globalCompositeOperation = "source-over";
      target.globalAlpha = 1;
    }

    function renderList(list, target, depth) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const layer = list[index];
        if (layer.folder) {
          const holder = surface(depth);
          holder.ctx.setTransform(1, 0, 0, 1, 0, 0);
          holder.ctx.clearRect(0, 0, width, height);
          renderList(layer.children, holder.ctx, depth + 1);
          composite(target, layer, holder.canvas);
          continue;
        }
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.clearRect(0, 0, width, height);
        bctx.setTransform(scale, 0, 0, scale, 0, 0);
        bctx.translate(layer.transform.x, layer.transform.y);
        bctx.rotate((layer.transform.rotation * Math.PI) / 180);
        bctx.scale(layer.transform.scale, layer.transform.scale);
        for (const shape of layer.shapes) {
          drawShape(bctx, shape);
        }
        let source = buffer;
        if (layer.mask) {
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.clearRect(0, 0, width, height);
          sctx.setTransform(scale, 0, 0, scale, 0, 0);
          sctx.translate(layer.mask.transform.x, layer.mask.transform.y);
          sctx.rotate((layer.mask.transform.rotation * Math.PI) / 180);
          sctx.scale(layer.mask.transform.scale, layer.mask.transform.scale);
          for (const shape of layer.mask.shapes) {
            drawShape(sctx, shape);
          }
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.globalCompositeOperation = "source-in";
          sctx.drawImage(buffer, 0, 0);
          sctx.globalCompositeOperation = "source-over";
          source = scratch;
        }
        composite(target, layer, source);
      }
    }

    function render() {
      if (!ctx) {
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (project.background) {
        ctx.fillStyle = project.background;
        ctx.fillRect(0, 0, width, height);
      }
      renderList(evaluate(frame), ctx, 0);
    }

    function tick() {
      const next = frame + 1;
      if (next < frameCount) {
        frame = next;
      } else if (loop) {
        frame = 0;
      } else {
        frame = frameCount - 1;
        player.pause();
      }
      render();
    }

    const player = {
      mount(target) {
        canvas = target;
        canvas.width = project.width;
        canvas.height = project.height;
        ctx = canvas.getContext("2d");
        buffer = document.createElement("canvas");
        buffer.width = project.width;
        buffer.height = project.height;
        bctx = buffer.getContext("2d");
        scratch = document.createElement("canvas");
        scratch.width = project.width;
        scratch.height = project.height;
        sctx = scratch.getContext("2d");
        render();
      },
      play() {
        if (playing || !ctx) {
          return;
        }
        playing = true;
        timer = setInterval(tick, 1000 / project.fps);
      },
      pause() {
        playing = false;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
      seek(value) {
        frame = clamp(Math.floor(value), 0, frameCount - 1);
        render();
      },
      setLoop(value) {
        loop = value;
      },
      get frame() {
        return frame;
      },
      get frameCount() {
        return frameCount;
      },
      get fps() {
        return project.fps;
      },
      get playing() {
        return playing;
      }
    };
    return player;
  }

  const api = { load };
  root.StickMate = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);