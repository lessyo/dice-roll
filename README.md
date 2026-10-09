# dice-box-threejs
3D Dice implemented with ThreeJS and Cannon ES

Based on [Major's 3D Dice](https://majorvictory.github.io/3DDiceRoller/)

The goal of this project is to decouple the UI of Major's 3D Dice and strip down the dice box to just the essentials. Just a module that accepts simple dice notation input and outputs a JSON object when the dice finish rolling.

Why another dice roller when you have [@3d-dice/dice-box](https://github.com/3d-dice/dice-box)?
Teall dice had already solved predeterministic rolling, which is a feature some developers really need. Major's 3D dice are based on Teall Dice.

## Demo
https://codesandbox.io/s/dice-box-threejs-j79h35?file=/src/index.js

## Install using NPM
```
npm install @3d-dice/dice-box-threejs
```

## Config Options
```
const defaultConfig = {
	framerate: (1/60),
	sounds: false,
	volume: 100,
	color_spotlight: 0xefdfd5,
	shadows: true,
	theme_surface:  "green-felt",
	sound_dieMaterial: 'plastic',
	theme_customColorset: null,
	theme_colorset: "white", // see available colorsets in https://github.com/3d-dice/dice-box-threejs/blob/main/src/const/colorsets.js
	theme_texture: "", // see available textures in https://github.com/3d-dice/dice-box-threejs/blob/main/src/const/texturelist.js
	theme_material: "glass", // "none" | "metal" | "wood" | "glass" | "plastic"
	gravity_multiplier: 400,
	light_intensity: 0.7,
	baseScale: 100,
	strength: 1, // toss strength of dice
	onRollComplete: () => {}
}
```

## Getting Results
### There are three ways to get results
1. You can define an `onRollComplete` callback function when creating the Dice Box
```
const Box = new DiceBox("#scene-container",{
  onRollComplete: (results) => {
    console.log(`I've got results :>> `, results);
  }
});
```
2. You can listen for the custom event that is triggered when results are ready
```
document.addEventListener("rollComplete",(e => {
  console.log(`I've got custom event results :>> `, e.detail);
}))
```
3. You can await the results from the `roll` method. Just be sure the function this call is in is `async`
```
setTimeout(async () => {
  const result = await Box.roll("6d6")
  console.log('result :>> ', result);
}, 1000);
```

## Predetermined Outcomes
As mentioned previously, this project was forked for it's predeterministic rolling capability. The notation to roll your predetermined outcomes looks like this:
```
Box.roll("6d6@4,4,4,4,4,4") // rolls six dice that will land on 4's
```

## Notes
In order to use textures or sounds, you will need to manually copy the assets out of the `./public` folder and into your static assets folder where you're building your app.

## Single D6 roll (`D6RollBox`)
A front-facing animation of one red six-sided die with white numbers on a transparent canvas, meant to be placed over a game interface.
The die flies in from the left edge of the screen, lands on an invisible floor, hits an invisible wall at the right edge of the screen and settles.
The value is decided before the roll: the throw is pre-simulated without rendering, the face numbers are rotated so the face that lands on top shows the requested value (opposite faces stay 1–6, 2–5, 3–4), and then the same throw is replayed on screen.

```
import { D6RollBox } from '@3d-dice/dice-box-threejs'

const box = new D6RollBox('#dice-container') // a selector or an element
await box.initialize()

const value = await box.roll(4) // resolves with 4 once the die has fully stopped
box.reset()   // stops the current roll (its promise rejects with an AbortError) and removes the die
box.destroy() // releases WebGL resources and listeners
```
`roll()` rejects if another roll is still in progress. The scene, camera and invisible walls follow the size of the container.
Layout and throw options:
- `viewSizeInDice` (default `4.7`) – how many die sizes fit into the shorter side of the screen, smaller values make the die bigger
- `floorScreenHeight` (default `0.25`) – share of the screen height below the invisible floor
- `spawnScreenHeight` (default `0.5`) – height of the screen, from the bottom, where the die flies in from the left
- `throwStrength` (default `1.5`) – how hard the die is thrown; it is automatically adjusted to the screen so the die tends to stop near the center
- `restZone` (default `0.3`) – share of the screen width around the center where the die has to stop (`1` accepts any position)
```
new D6RollBox('#dice-container', { viewSizeInDice: 6, floorScreenHeight: 0.1, restZone: 0.2 })
```
Run `npm run dev` for a demo page.
