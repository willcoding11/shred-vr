// Reproduces the in-headset panel orientation: the HUD and menu are children of the rig, so
// their positions are rig-local but Object3D.lookAt takes a WORLD-space target.
// Run: node tools/vr-panel-test.mjs
import * as THREE from '../node_modules/three/build/three.module.js';

const rig = new THREE.Group();
rig.position.set(6, -51, 297);                 // the rig tracks the board down the hill
rig.rotation.y = 0.8;
const scene = new THREE.Scene(); scene.add(rig);

const headLocal = new THREE.Vector3(0.05, 1.6, 0.02);   // what controls.js reports
const fwd = new THREE.Vector3(0, 0, -1);

function place(useWorldTarget) {
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.29), new THREE.MeshBasicMaterial());
  rig.add(panel);
  const p = headLocal.clone().addScaledVector(fwd, 1.25); p.y = Math.max(0.6, headLocal.y - 0.42);
  panel.position.copy(p);
  rig.updateMatrixWorld(true);
  panel.lookAt(useWorldTarget ? rig.localToWorld(headLocal.clone()) : headLocal.clone());
  rig.updateMatrixWorld(true);
  // angle between the panel's facing normal and the direction to the viewer
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(panel.getWorldQuaternion(new THREE.Quaternion()));
  const toViewer = rig.localToWorld(headLocal.clone()).sub(panel.getWorldPosition(new THREE.Vector3())).normalize();
  rig.remove(panel);
  return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(n.dot(toViewer), -1, 1)));
}

const bad = place(false), good = place(true);
console.log(`rig-local target (the bug): ${bad.toFixed(1)}deg off facing the viewer`);
console.log(`world-space target (fixed): ${good.toFixed(1)}deg off facing the viewer`);
const pass = good < 1;
console.log(pass ? 'PASS: the panel faces the player.' : 'FAIL: the panel is not facing the player.');
process.exit(pass ? 0 : 1);
