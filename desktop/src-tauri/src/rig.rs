use serde::{Deserialize, Serialize};

use crate::document::{apply_affine, Affine, Bounds, Point, Shape};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub base: Point,
    pub tip: Point,
    pub angle: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bone {
    pub parent: Option<usize>,
    #[serde(default)]
    pub anchor: Point,
    pub length: f64,
    pub twist: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub art: Vec<Shape>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Figure {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub bones: Vec<Bone>,
}

pub const LIMB_WIDTH: f64 = 6.0;

pub fn places(figure: &Figure) -> Vec<Place> {
    let root = Point {
        x: figure.x,
        y: figure.y,
    };
    let mut out: Vec<Place> = Vec::with_capacity(figure.bones.len());
    for bone in &figure.bones {
        let (frame, parent_angle) = match bone.parent.and_then(|index| out.get(index)) {
            Some(parent) => (parent.tip, parent.angle),
            None => (root, figure.rotation.to_radians()),
        };
        let angle = parent_angle + bone.twist.to_radians();
        let base = Point {
            x: frame.x + bone.anchor.x * angle.cos() - bone.anchor.y * angle.sin(),
            y: frame.y + bone.anchor.x * angle.sin() + bone.anchor.y * angle.cos(),
        };
        out.push(Place {
            base,
            tip: Point {
                x: base.x + bone.length * angle.cos(),
                y: base.y + bone.length * angle.sin(),
            },
            angle,
        });
    }
    out
}

pub fn bone_matrix(place: &Place) -> Affine {
    let cos = place.angle.cos();
    let sin = place.angle.sin();
    Affine {
        a: cos,
        b: sin,
        c: -sin,
        d: cos,
        e: place.base.x,
        f: place.base.y,
    }
}

pub fn swing(figure: &mut Figure, bone: usize, target: &Point) -> Result<(), String> {
    let places = places(figure);
    let place = *places.get(bone).ok_or_else(|| "no such bone".to_string())?;
    let parent_angle = match figure.bones[bone].parent.and_then(|index| places.get(index)) {
        Some(parent) => parent.angle,
        None => figure.rotation.to_radians(),
    };
    let dx = target.x - place.base.x;
    let dy = target.y - place.base.y;
    if dx.hypot(dy) < 0.001 {
        return Err("the pointer is on the joint".to_string());
    }
    figure.bones[bone].twist = (dy.atan2(dx) - parent_angle).to_degrees();
    Ok(())
}

pub fn art_frames(figure: &Figure) -> Vec<(usize, Affine)> {
    places(figure)
        .iter()
        .enumerate()
        .filter(|(index, _)| !figure.bones[*index].art.is_empty())
        .map(|(index, place)| (index, bone_matrix(place)))
        .collect()
}

pub fn art_shapes(figure: &Figure) -> Vec<Shape> {
    let mut out = Vec::new();
    for (index, place) in places(figure).iter().enumerate() {
        for shape in &figure.bones[index].art {
            if let Ok(moved) = to_world(shape, place) {
                out.push(moved);
            }
        }
    }
    out
}

fn to_world(shape: &Shape, place: &Place) -> Result<Shape, String> {
    crate::shapes::converted(
        shape,
        &bone_matrix(place),
        1.0,
        place.angle.to_degrees(),
    )
}

fn to_local(shape: &Shape, place: &Place) -> Result<Shape, String> {
    let inverse = invert(&bone_matrix(place)).ok_or_else(|| "bone has no inverse".to_string())?;
    crate::shapes::converted(shape, &inverse, 1.0, -place.angle.to_degrees())
}

pub fn figure_bounds(figure: &Figure) -> Option<Bounds> {
    let places = places(figure);
    let mut out: Option<Bounds> = None;
    for (index, place) in places.iter().enumerate() {
        if figure.bones[index].length <= 0.0 {
            continue;
        }
        let limb = limb_bounds(place.base, place.tip, figure.bones[index].width.max(1.0));
        out = Some(match out {
            Some(current) => union(current, limb),
            None => limb,
        });
    }
    for (index, matrix) in art_frames(figure) {
        let local = crate::document::shape_bounds(&Shape::Group {
            children: figure.bones[index].art.clone(),
        });
        let corners = box_corners(&local)
            .iter()
            .map(|point| apply_affine(&matrix, point))
            .collect::<Vec<_>>();
        out = Some(match out {
            Some(current) => union(current, points_box(&corners)),
            None => points_box(&corners),
        });
    }
    out
}

pub fn place_art(figure: &mut Figure, bone: usize, shapes: Vec<Shape>) -> Result<(), String> {
    let place = *places(figure)
        .get(bone)
        .ok_or_else(|| "no such bone".to_string())?;
    for shape in shapes {
        figure.bones[bone].art.push(to_local(&shape, &place)?);
    }
    Ok(())
}

pub fn detach_art(figure: &Figure, bone: usize) -> Result<Vec<Shape>, String> {
    let place = *places(figure)
        .get(bone)
        .ok_or_else(|| "no such bone".to_string())?;
    figure.bones[bone]
        .art
        .iter()
        .map(|shape| to_world(shape, &place))
        .collect()
}

pub fn invert(matrix: &Affine) -> Option<Affine> {
    let det = matrix.a * matrix.d - matrix.b * matrix.c;
    if det.abs() < 1e-9 {
        return None;
    }
    Some(Affine {
        a: matrix.d / det,
        b: -matrix.b / det,
        c: -matrix.c / det,
        d: matrix.a / det,
        e: (matrix.c * matrix.f - matrix.d * matrix.e) / det,
        f: (matrix.b * matrix.e - matrix.a * matrix.f) / det,
    })
}

pub fn limb_bounds(base: Point, tip: Point, width: f64) -> Bounds {
    let pad = width / 2.0;
    let x = base.x.min(tip.x) - pad;
    let y = base.y.min(tip.y) - pad;
    Bounds {
        x,
        y,
        w: base.x.max(tip.x) + pad - x,
        h: base.y.max(tip.y) + pad - y,
    }
}

fn box_corners(bounds: &Bounds) -> [Point; 4] {
    [
        Point {
            x: bounds.x,
            y: bounds.y,
        },
        Point {
            x: bounds.x + bounds.w,
            y: bounds.y,
        },
        Point {
            x: bounds.x + bounds.w,
            y: bounds.y + bounds.h,
        },
        Point {
            x: bounds.x,
            y: bounds.y + bounds.h,
        },
    ]
}

fn points_box(points: &[Point]) -> Bounds {
    let left = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let top = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let right = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let bottom = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    Bounds {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    }
}

fn union(a: Bounds, b: Bounds) -> Bounds {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Bounds {
        x,
        y,
        w: (a.x + a.w).max(b.x + b.w) - x,
        h: (a.y + a.h).max(b.y + b.h) - y,
    }
}

fn limb(length: f64, parent: Option<usize>, twist: f64) -> Bone {
    Bone {
        parent,
        anchor: Point::default(),
        length,
        twist,
        width: LIMB_WIDTH,
        color: "#27272a".to_string(),
        art: Vec::new(),
    }
}

pub fn humanoid(x: f64, y: f64, height: f64) -> Figure {
    let unit = height / 100.0;
    let bone = |length: f64, parent: Option<usize>, twist: f64| Bone {
        width: LIMB_WIDTH * unit,
        ..limb(length * unit, parent, twist)
    };
    let skull = 10.0 * unit;
    let mut figure = Figure {
        x,
        y,
        rotation: 0.0,
        bones: vec![
            bone(0.0, None, 0.0),
            bone(26.0, Some(0), -90.0),
            bone(4.0, Some(1), 0.0),
            bone(0.0, Some(2), 0.0),
        ],
    };
    figure.bones[3].art.push(Shape::Ellipse {
        x: 0.0,
        y: -skull,
        w: skull * 2.0,
        h: skull * 2.0,
        fill: "#27272a".to_string(),
        stroke: "none".to_string(),
        width: 0.0,
        gradient: None,
    });
    for sign in [-1.0, 1.0] {
        let arm = figure.bones.len();
        let leg = arm + 2;
        figure.bones.push(bone(18.0, Some(1), 180.0 + 12.0 * sign));
        figure.bones.push(bone(16.0, Some(arm), 10.0 * sign));
        figure.bones.push(bone(26.0, Some(0), 90.0 + 5.0 * sign));
        figure.bones.push(bone(24.0, Some(leg), 3.0 * sign));
    }
    figure
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::TextAlign;

    fn chain() -> Figure {
        Figure {
            x: 100.0,
            y: 100.0,
            rotation: 0.0,
            bones: vec![
                Bone {
                    parent: None,
                    anchor: Point { x: 0.0, y: 0.0 },
                    length: 40.0,
                    twist: 0.0,
                    width: 4.0,
                    color: "#000000".to_string(),
                    art: Vec::new(),
                },
                Bone {
                    parent: Some(0),
                    anchor: Point { x: 0.0, y: 0.0 },
                    length: 25.0,
                    twist: 0.0,
                    width: 4.0,
                    color: "#000000".to_string(),
                    art: Vec::new(),
                },
            ],
        }
    }

    fn distance(place: &Place) -> f64 {
        (place.tip.x - place.base.x)
            .hypot(place.tip.y - place.base.y)
    }

    #[test]
    fn bones_point_along_their_parents() {
        let places = places(&chain());
        assert_eq!((places[0].base.x, places[0].tip.x), (100.0, 140.0));
        assert_eq!((places[1].base.x, places[1].tip.x), (140.0, 165.0));
    }

    #[test]
    fn swinging_keeps_every_length() {
        let mut figure = chain();
        swing(&mut figure, 0, &Point { x: 100.0, y: 60.0 }).expect("swing");
        let places = places(&figure);
        assert!((distance(&places[0]) - 40.0).abs() < 0.0001);
        assert!((distance(&places[1]) - 25.0).abs() < 0.0001);
        assert!((places[0].tip.x - 100.0).abs() < 0.0001);
        assert!((places[0].tip.y - 60.0).abs() < 0.0001);
        assert!((places[1].tip.y - 35.0).abs() < 0.0001);
    }

    #[test]
    fn a_twist_of_zero_points_at_the_target() {
        let mut figure = chain();
        swing(&mut figure, 0, &Point { x: 120.0, y: 120.0 }).expect("swing");
        let place = places(&figure)[0];
        assert!((place.tip.x - 128.2843).abs() < 0.01);
        assert!((place.tip.y - 128.2843).abs() < 0.01);
    }

    #[test]
    fn anchors_sit_in_the_parents_frame() {
        let mut figure = chain();
        figure.bones[1].anchor = Point { x: 0.0, y: 10.0 };
        let placed = places(&figure);
        assert!((placed[1].base.x - 140.0).abs() < 0.0001);
        assert!((placed[1].base.y - 110.0).abs() < 0.0001);
        figure.rotation = 90.0;
        let turned = places(&figure);
        assert!((turned[0].base.x - 100.0).abs() < 0.0001);
        assert!((turned[0].base.y - 100.0).abs() < 0.0001);
        assert!((turned[1].base.y - 140.0).abs() < 0.0001);
    }

    #[test]
    fn an_unknown_bone_is_refused() {
        let mut figure = chain();
        assert!(swing(&mut figure, 9, &Point { x: 0.0, y: 0.0 }).is_err());
        assert!(place_art(&mut figure, 9, Vec::new()).is_err());
        assert!(detach_art(&figure, 9).is_err());
        assert!(swing(&mut figure, 0, &Point { x: 100.0, y: 100.0 }).is_err());
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Shape {
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill: "#ff0000".to_string(),
            stroke: "none".to_string(),
            width: 0.0,
            gradient: None,
        }
    }

    fn corners(shape: &Shape) -> Vec<Point> {
        match shape {
            Shape::Path { nodes, .. } => nodes.iter().map(|node| node.point).collect(),
            other => panic!("expected a path, got {other:?}"),
        }
    }

    #[test]
    fn art_is_stored_in_the_bones_frame_and_drawn_in_the_world() {
        let mut figure = chain();
        swing(&mut figure, 0, &Point { x: 100.0, y: 140.0 }).expect("swing");
        place_art(&mut figure, 0, vec![rect(140.0, 95.0, 20.0, 10.0)]).expect("place");
        assert_eq!(art_frames(&figure).len(), 1);
        let stored = corners(&figure.bones[0].art[0]);
        assert!((stored[0].x + 5.0).abs() < 0.0001);
        assert!((stored[0].y + 40.0).abs() < 0.0001);
        let drawn = corners(&art_shapes(&figure)[0]);
        assert!((drawn[0].x - 140.0).abs() < 0.0001);
        assert!((drawn[0].y - 95.0).abs() < 0.0001);
        assert!((drawn[2].x - 160.0).abs() < 0.0001);
        assert!((drawn[2].y - 105.0).abs() < 0.0001);
    }

    #[test]
    fn detaching_art_puts_it_back_on_the_stage() {
        let mut figure = chain();
        swing(&mut figure, 0, &Point { x: 140.0, y: 140.0 }).expect("swing");
        place_art(&mut figure, 0, vec![rect(100.0, 100.0, 8.0, 4.0)]).expect("place");
        let world = detach_art(&figure, 0).expect("detach");
        let want = [
            Point { x: 100.0, y: 100.0 },
            Point { x: 108.0, y: 100.0 },
            Point { x: 108.0, y: 104.0 },
            Point { x: 100.0, y: 104.0 },
        ];
        let drawn = corners(&world[0]);
        assert_eq!(drawn.len(), want.len());
        for (got, expected) in drawn.iter().zip(want.iter()) {
            assert!((got.x - expected.x).abs() < 0.0001);
            assert!((got.y - expected.y).abs() < 0.0001);
        }
    }

    #[test]
    fn bounds_cover_limbs_and_art() {
        let mut figure = chain();
        figure.bones[0].art.push(rect(0.0, -20.0, 40.0, 40.0));
        let bounds = figure_bounds(&figure).expect("bounds");
        assert!((bounds.x - 98.0).abs() < 0.0001);
        assert!((bounds.y - 80.0).abs() < 0.0001);
        assert!((bounds.w - 69.0).abs() < 0.0001);
        assert!((bounds.h - 40.0).abs() < 0.0001);
    }

    #[test]
    fn a_default_figure_is_upright_and_in_proportion() {
        let figure = humanoid(200.0, 320.0, 200.0);
        assert_eq!(figure.bones.len(), 12);
        let places = places(&figure);
        let hip = places[0].base;
        assert_eq!(places[0].tip, places[0].base);
        assert!((places[1].tip.x - hip.x).abs() < 0.01);
        assert!((places[1].tip.y - (hip.y - 52.0)).abs() < 0.01);
        let bounds = figure_bounds(&figure).expect("bounds");
        assert!((bounds.y - (hip.y - 100.0)).abs() < 0.01, "crown {}", bounds.y);
        assert!((bounds.h - 205.34).abs() < 0.5, "height {}", bounds.h);
        assert!((bounds.w - 50.96).abs() < 0.5, "width {}", bounds.w);
        for (left, right) in [(4usize, 8usize), (5, 9), (6, 10), (7, 11)] {
            assert!((places[left].tip.x + places[right].tip.x - 400.0).abs() < 0.0001);
            assert!((places[left].tip.y - places[right].tip.y).abs() < 0.0001);
        }
        assert!(places[5].tip.y > places[4].base.y, "arms hang down");
        assert!(places[7].tip.y > hip.y, "legs reach below the hip");
    }

    #[test]
    fn the_skull_is_art_on_a_joint() {
        let figure = humanoid(200.0, 320.0, 200.0);
        assert_eq!(figure.bones[3].length, 0.0);
        assert_eq!(figure.bones[3].art.len(), 1);
        let skull = crate::document::shape_bounds(&art_shapes(&figure)[0]);
        assert!((skull.x - 180.0).abs() < 0.01);
        assert!((skull.y - 220.0).abs() < 0.01);
        assert!((skull.w - 40.0).abs() < 0.01);
    }

    #[test]
    fn turning_the_neck_swings_the_skull() {
        let mut figure = humanoid(200.0, 320.0, 200.0);
        swing(&mut figure, 2, &Point { x: 240.0, y: 268.0 }).expect("swing");
        let place = places(&figure)[3];
        assert!((place.angle - 0.0).abs() < 0.0001);
        assert!((place.base.x - 208.0).abs() < 0.01);
        let skull = crate::document::shape_bounds(&art_shapes(&figure)[0]);
        assert!((skull.x - 208.0).abs() < 0.01);
        assert!((skull.y - 248.0).abs() < 0.01);
        assert!((skull.w - 40.0).abs() < 0.01);
    }

    #[test]
    fn posing_a_default_limb_reaches_for_the_pointer() {
        let mut figure = humanoid(200.0, 320.0, 200.0);
        let forearm = 5usize;
        let length = distance(&places(&figure)[forearm]);
        let base = places(&figure)[forearm].base;
        let target = Point {
            x: base.x + 60.0,
            y: base.y - 60.0,
        };
        swing(&mut figure, forearm, &target).expect("swing");
        let place = places(&figure)[forearm];
        assert!((distance(&place) - length).abs() < 0.0001);
        let aimed = (place.tip.x - target.x, place.tip.y - target.y);
        assert!((aimed.0 - (place.tip.x - target.x)).abs() < 0.0001);
        assert!(place.angle < 0.0);
    }

    #[test]
    fn the_bone_matrix_matches_a_canvas_transform() {
        let place = places(&chain())[0];
        let local = Point { x: 12.0, y: 5.0 };
        let direct = apply_affine(&bone_matrix(&place), &local);
        let swung = {
            let mut figure = chain();
            swing(&mut figure, 0, &Point { x: 120.0, y: 140.0 }).expect("swing");
            figure
        };
        let place = places(&swung)[0];
        let rotated = apply_affine(&bone_matrix(&place), &local);
        let forward = apply_affine(&bone_matrix(&place), &Point { x: 40.0, y: 0.0 });
        assert!((direct.x - 112.0).abs() < 0.0001);
        assert!((direct.y - 105.0).abs() < 0.0001);
        assert!((rotated.x - 100.8944).abs() < 0.01);
        assert!((rotated.y - 112.9692).abs() < 0.01);
        assert!((forward.x - place.tip.x).abs() < 0.0001);
        assert!((forward.y - place.tip.y).abs() < 0.0001);
    }

    #[test]
    fn a_figure_keeps_text_and_nested_shapes() {
        let mut figure = chain();
        figure.bones[1].art.push(Shape::Text {
            x: 2.0,
            y: 3.0,
            text: "hi".to_string(),
            size: 12.0,
            family: "Arial".to_string(),
            color: "#000000".to_string(),
            spacing: 0.0,
            leading: 1.2,
            align: TextAlign::Left,
            matrix: None,
        });
        figure.bones[1].art.push(Shape::Group {
            children: vec![rect(0.0, 0.0, 3.0, 3.0)],
        });
        assert!(figure_bounds(&figure).is_some());
        let detached = detach_art(&figure, 1).expect("detach");
        assert_eq!(detached.len(), 2);
        assert!(matches!(detached[1], Shape::Group { .. }));
    }
}
