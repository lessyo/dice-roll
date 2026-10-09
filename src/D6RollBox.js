import * as THREE from "three"
import * as CANNON from "cannon-es"

import { DiceBox } from './DiceBox.js'
import { debounce } from "./helpers"

// World axes are the same as in DiceBox: z is up (gravity is -z), x goes left to right.
// The camera looks at the scene from the front (from -y), so y is the depth of the scene.

const defaultConfig = {
	theme_customColorset: {
		name: 'd6-red',
		foreground: '#ffffff',
		background: '#d0141e',
		outline: 'none',
		texture: 'none',
		material: 'plastic'
	},
	// decorative dice thrown together with the red one, their values are random
	extraDice: 2,
	extraColorset: {
		name: 'd6-white',
		foreground: '#111111',
		background: '#f2f2f2',
		outline: 'none',
		texture: 'none',
		material: 'plastic'
	},
	shadows: false,
	sounds: false,
	light_intensity: 1,
	// how many die sizes fit into the shorter side of the viewport
	viewSizeInDice: 4.7,
	camera_fov: 22,
	// downward tilt of the camera in degrees, just enough to see the top face
	camera_pitch: 20,
	// share of the screen height below the floor (measured in the middle of the play area depth)
	floorScreenHeight: 0.25,
	// the die appears from behind the left edge at this share of the screen height from the bottom
	spawnScreenHeight: 0.5,
	// depth of the play area between the invisible front and back walls, in die sizes
	depthInDice: 3.2,
	// a vertical wall looks slightly tilted from a pitched camera, it lines up with the screen edge at this height (in die sizes)
	wallFitHeight: 3,
	// 1 is a gentle toss, bigger values throw the die faster and more downwards
	throwStrength: 1.5,
	// the die has to stop within this share of the screen width around the center, 1 accepts any position
	restZone: 0.3,
	// bounciness of the dice against the floor, the right wall, the other invisible limits and each other
	restitution: { floor: 0.7, wall: 0.55, barrier: 0.45, dice: 0.65 },
	// contact softness: lower stiffness and higher relaxation cushion the hits instead of a hard knock,
	// too soft contacts let the dice visibly sink into the floor
	contactStiffness: 4e6,
	contactRelaxation: 4,
	sleepSpeedLimit: 8,
	sleepTimeLimit: 0.6,
	// pre-simulation limits: steps per throw and throws per roll
	presimStepLimit: 1500,
	maxThrowAttempts: 80,
}

const abortError = () => {
	const error = new Error('Roll cancelled')
	error.name = 'AbortError'
	return error
}

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0))

const rand = (min, max) => min + Math.random() * (max - min)

const directionKey = v => `${v.x},${v.y},${v.z}`

class D6RollBox extends DiceBox {

	constructor(element_container, options = {}) {
		super(element_container, Object.assign({}, defaultConfig, options))
		this.DiceFactory.setBumpMapping(false)

		this.dieType = 'd6'
		// the red die with the requested result, decorDice are the extra white ones
		this.die = null
		this.decorDice = []
		this.extraColorData = null
		this.bounds = null
		this.pendingBounds = false
		this.activeRoll = null
		this.rollCounter = 0
		// adjusts throwStrength to the screen so the die tends to stop near the center, see learnFromThrow
		this.throwBoost = 1
		this.boundaryNames = new Map()
		this.resizeObserver = null
		this.onWindowResize = null
	}

	async initialize() {
		await super.initialize()
		this.extraColorData = await this.DiceColors.makeColorSet(this.extraColorset)
	}

	dieMetrics() {
		const radius = this.DiceFactory.get(this.dieType).scale * this.baseScale
		const half = radius / Math.sqrt(3)
		return { radius, half, size: half * 2 }
	}

	setDimensions() {
		const width = this.container.clientWidth
		const height = this.container.clientHeight
		// a hidden container gets its camera and walls on the first resize with a real size
		if (!this.camera) this.camera = new THREE.PerspectiveCamera()
		if (!width || !height) return

		this.display.currentWidth = width / 2
		this.display.currentHeight = height / 2
		this.display.containerWidth = width
		this.display.containerHeight = height
		this.display.aspect = width / height

		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
		this.renderer.setSize(width, height)
		this.renderer.domElement.style.display = 'block'

		this.updateCamera(width / height)
		this.updateLights()

		// replaying a pre-simulated roll needs the exact same world, so walls move after the roll
		if (this.rolling) this.pendingBounds = true
		else this.makeWorldBox()

		this.renderer.render(this.scene, this.camera)
	}

	updateCamera(aspect) {
		const { size } = this.dieMetrics()
		const pitch = THREE.MathUtils.degToRad(this.camera_pitch)
		const visibleHeight = this.viewSizeInDice * size / Math.min(1, aspect)
		const distance = visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera_fov) / 2))

		if (!this.camera) this.camera = new THREE.PerspectiveCamera()
		const camera = this.camera
		camera.fov = this.camera_fov
		camera.aspect = aspect
		camera.near = distance / 10
		camera.far = distance * 4
		camera.up.set(0, 0, 1)
		camera.position.set(0, -distance * Math.cos(pitch), distance * Math.sin(pitch))
		camera.lookAt(0, 0, 0)
		camera.updateProjectionMatrix()
		camera.updateMatrixWorld()

		// lift the camera so the floor is at the requested height of the screen
		const floorLine = this.screenLinePlane(this.floorScreenHeight)
		const floorOnScreen = this.solvePlane(floorLine, 'z', { x: 0, y: 0 })
		camera.position.z -= floorOnScreen
		camera.updateMatrixWorld()
	}

	updateLights() {
		if (this.light) return
		this.light_amb = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 0.75 * this.light_intensity)
		this.light = new THREE.DirectionalLight(0xffffff, 0.9 * this.light_intensity)
		this.light.position.set(-1, -1.5, 2.5)
		this.scene.add(this.light_amb, this.light, this.light.target)
	}

	// plane through the camera and one edge of the screen, given by two NDC corners
	screenEdgePlane(ndcA, ndcB) {
		const a = new THREE.Vector3(ndcA[0], ndcA[1], 0.5).unproject(this.camera)
		const b = new THREE.Vector3(ndcB[0], ndcB[1], 0.5).unproject(this.camera)
		return new THREE.Plane().setFromCoplanarPoints(this.camera.position, a, b)
	}

	// plane through the camera and a horizontal line of the screen, height is a share of the screen from the bottom
	screenLinePlane(height) {
		const ndcY = height * 2 - 1
		return this.screenEdgePlane([-1, ndcY], [1, ndcY])
	}

	// finds the missing coordinate of a point lying on the plane
	solvePlane(plane, axis, point) {
		const { normal, constant } = plane
		let sum = constant
		for (const key of ['x', 'y', 'z']) {
			if (key !== axis) sum += normal[key] * point[key]
		}
		return -sum / normal[axis]
	}

	computeBounds() {
		const { size } = this.dieMetrics()
		const depthHalf = this.depthInDice * size / 2
		const front = -depthHalf
		const back = depthHalf

		const top = this.screenEdgePlane([-1, 1], [1, 1])
		const right = this.screenEdgePlane([1, -1], [1, 1])
		const left = this.screenEdgePlane([-1, 1], [-1, -1])

		// the part of the play area closest to the camera is the narrowest on screen
		const ceiling = Math.min(
			this.solvePlane(top, 'z', { x: 0, y: front }),
			this.solvePlane(top, 'z', { x: 0, y: back })
		)
		const rightX = this.solvePlane(right, 'x', { y: front, z: Math.min(ceiling, this.wallFitHeight * size) })
		const leftX = Math.min(
			this.solvePlane(left, 'x', { y: back, z: 0 }),
			this.solvePlane(left, 'x', { y: back, z: ceiling })
		)

		return {
			floor: 0,
			ceiling,
			right: rightX,
			// far enough behind the left edge of the screen to let all the dice fly in
			left: leftX - this.dieMetrics().radius * 3 - this.extraDice * 2 * size,
			front,
			back,
			depthHalf,
			leftPlane: left,
			rightPlane: right
		}
	}

	makeWorldBox() {
		if (!this.container.clientWidth || !this.container.clientHeight) return
		if (!this.box_body.floor) this.createWorldBox()

		const bounds = this.bounds = this.computeBounds()
		this.pendingBounds = false

		this.box_body.floor.position.set(0, 0, bounds.floor)
		this.box_body.ceiling.position.set(0, 0, bounds.ceiling)
		this.box_body.right.position.set(bounds.right, 0, 0)
		this.box_body.left.position.set(bounds.left, 0, 0)
		this.box_body.front.position.set(0, bounds.front, 0)
		this.box_body.back.position.set(0, bounds.back, 0)

		this.keepRestingDiceInView()
	}

	createWorldBox() {
		const floorMaterial = new CANNON.Material('floor')
		const wallMaterial = new CANNON.Material('wall')
		const barrierMaterial = new CANNON.Material('barrier')

		const restitution = this.restitution
		const contact = (material, friction, bounce) => new CANNON.ContactMaterial(material, this.dice_body_material, {
			friction,
			restitution: bounce,
			contactEquationStiffness: this.contactStiffness,
			contactEquationRelaxation: this.contactRelaxation
		})
		this.world.addContactMaterial(contact(floorMaterial, 0.45, restitution.floor))
		this.world.addContactMaterial(contact(wallMaterial, 0.3, restitution.wall))
		this.world.addContactMaterial(contact(barrierMaterial, 0, restitution.barrier))
		this.world.addContactMaterial(contact(this.dice_body_material, 0.4, restitution.dice))

		// invisible planes, every normal points into the play area
		const walls = {
			floor: [floorMaterial],
			ceiling: [barrierMaterial, new CANNON.Vec3(1, 0, 0), Math.PI],
			right: [wallMaterial, new CANNON.Vec3(0, 1, 0), -Math.PI / 2],
			left: [barrierMaterial, new CANNON.Vec3(0, 1, 0), Math.PI / 2],
			front: [barrierMaterial, new CANNON.Vec3(1, 0, 0), -Math.PI / 2],
			back: [barrierMaterial, new CANNON.Vec3(1, 0, 0), Math.PI / 2],
		}

		Object.entries(walls).forEach(([name, [material, axis, angle]]) => {
			const body = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material })
			if (axis) body.quaternion.setFromAxisAngle(axis, angle)
			this.world.addBody(body)
			this.box_body[name] = body
			this.boundaryNames.set(body, name)
		})
	}

	// after a resize the dice that are already lying on the floor may end up behind a screen edge
	keepRestingDiceInView() {
		if (this.rolling) return
		const { half } = this.dieMetrics()
		const extent = half * Math.SQRT2

		this.diceList.forEach(die => {
			if (!die.body || !die.parent) return
			const position = die.body.position
			const minX = this.visibleLeftX(position.y, position.z, extent)
			const maxX = this.bounds.right - extent
			position.x = Math.max(Math.min(position.x, maxX), minX)
			die.position.copy(position)
		})
	}

	// smallest x at which a sphere of the given radius at (y, z) is fully right of the left screen edge
	visibleLeftX(y, z, radius) {
		const plane = this.bounds.leftPlane
		return this.solvePlane(plane, 'x', { y, z }) + radius / Math.abs(plane.normal.x)
	}

	resizeWorld() {
		const onResize = debounce(() => this.setDimensions())
		if (window.ResizeObserver) {
			this.resizeObserver = new ResizeObserver(onResize)
			this.resizeObserver.observe(this.container)
		} else {
			this.onWindowResize = onResize
			window.addEventListener('resize', onResize)
		}
	}

	createDie(colorData) {
		this.DiceFactory.applyColorSet(colorData)
		const die = this.DiceFactory.create(this.dieType)
		this.DiceFactory.applyColorSet(this.colorData)

		// the die keeps its own copy of the geometry, its face groups are remapped for forced results
		const shared = die.geometry
		die.geometry = shared.clone()
		// and its own physics shape, convex shapes cache their world-space data
		die.geometry.cannon_shape = this.DiceFactory.createGeometry(this.dieType, this.dieMetrics().radius, true)
		die.sharedGeometry = shared
		die.notation = { type: this.dieType }
		die.castShadow = false
		return die
	}

	createDice() {
		this.die = this.createDie(this.colorData)
		this.decorDice = Array.from({ length: this.extraDice }, () => this.createDie(this.extraColorData))
		this.diceList = [this.die, ...this.decorDice]
	}

	resetFaceLayout(die) {
		const groups = die.sharedGeometry.groups
		die.geometry.groups.forEach((group, i) => group.materialIndex = groups[i].materialIndex)
	}

	// puts the dice bodies in their initial state for the given throw, always in the same order
	resetDice(vectors) {
		// falling asleep is timed with world.time, rounding errors would differ between runs started at different times
		this.world.time = 0
		this.diceList.forEach((die, i) => {
			die.result = []
			die.resultReason = 'natural'
			die.rerolling = false
			die.notation = vectors[i]
			this.spawnDice(vectors[i], die)
			die.body.sleepSpeedLimit = this.sleepSpeedLimit
			die.body.sleepTimeLimit = this.sleepTimeLimit
		})
	}

	// returns the initial state of every die in diceList order
	generateThrow() {
		const { radius, half, size } = this.dieMetrics()
		const bounds = this.bounds
		const g = Math.abs(this.world.gravity.z)
		const lane = Math.max(0, bounds.depthHalf - radius)
		const zLimit = z => Math.max(Math.min(z, bounds.ceiling - radius * 1.2), radius * 1.2)

		// the dice fly in one after another, staggered in depth and height so they don't overlap
		const spawnLine = this.screenLinePlane(this.spawnScreenHeight + rand(-0.04, 0.04))
		const spawnZ = this.solvePlane(spawnLine, 'z', { x: 0, y: 0 })
		const slots = this.diceList.map((die, i) => {
			const side = i === 0 ? 0 : (i % 2 ? 1 : -1)
			const y = Math.max(-lane, Math.min(lane, side * Math.min(0.55 * size, lane) + rand(-0.1, 0.1) * size))
			return { dx: -1.9 * size * i, y, z: zLimit(spawnZ + (i % 2) * 0.5 * size + rand(-0.1, 0.1) * size) }
		})
		// the red die takes a random place in the line
		for (let i = slots.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			const slot = slots[i]
			slots[i] = slots[j]
			slots[j] = slot
		}

		// start completely hidden behind the left edge of the screen
		const leadX = Math.min(...slots.map(slot => this.visibleLeftX(slot.y, slot.z, -radius) - 1 - slot.dx))

		// horizontal speed in shares of the way to the right wall per second, limited on very wide screens
		const distance = bounds.right - half - leadX
		const strength = this.throwStrength * this.throwBoost
		const speed = rand(1.2, 1.7) * Math.min(distance, 9 * size) * strength
		const spin = Math.sqrt(strength)

		return slots.map(({ dx, y, z }) => {
			const vx = speed * rand(0.94, 1.06)
			// vertical speed is picked so the first floor hit is a part of the way to the wall,
			// a low start makes the die fly in an arc, a high one throws it downwards
			const fallTime = rand(0.45, 0.75) * distance / vx
			const vz = (0.5 * g * fallTime * fallTime - (z - half)) / fallTime
			const axis = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize()

			return {
				type: this.dieType,
				pos: { x: leadX + dx, y, z },
				velocity: { x: vx, y: rand(-0.02, 0.02) * vx, z: vz },
				// spin forward (around +y) plus some random tumbling
				angle: { x: rand(-4, 4), y: rand(12, 28) * spin, z: rand(-4, 4) },
				axis: { x: axis.x, y: axis.y, z: axis.z, a: Math.random() }
			}
		})
	}

	// runs the throw without rendering and reports how it went
	presimulate(vectors) {
		this.resetDice(vectors)

		const bodies = this.diceList.map(die => die.body)
		const body = this.die.body
		const floor = this.box_body.floor
		const rightPlane = this.bounds.rightPlane
		const { half } = this.dieMetrics()
		const corners = [-half, half].flatMap(x => [-half, half].flatMap(y => [-half, half].map(z => new CANNON.Vec3(x, y, z))))
		const corner = new CANNON.Vec3()
		const report = { sequence: [], airborneWallHit: false, lastSpin: bodies.map(() => 0), offscreen: false, touchedLimits: false }

		// collision sequence of the red die
		const onCollide = ({ body: other }) => {
			const name = this.boundaryNames.get(other)
			if (!name) return
			if (name === 'right' && !report.sequence.includes('right')) {
				report.airborneWallHit = !this.world.contacts.some(c => (c.bi === body && c.bj === floor) || (c.bi === floor && c.bj === body))
			}
			report.sequence.push(name)
		}
		// no die should fly back behind the left edge of the screen
		const onAnyCollide = ({ body: other }) => {
			if (this.boundaryNames.get(other) === 'left') report.touchedLimits = true
		}
		const onPostStep = () => {
			bodies.forEach((die, i) => {
				// angular velocity is zeroed when the body falls asleep, remember the last one
				report.lastSpin[i] = die.angularVelocity.length()
				// the dice must not cross the right edge of the screen above the height the wall is fitted to
				if (report.offscreen) return
				report.offscreen = corners.some(local => {
					die.pointToWorldFrame(local, corner)
					return corner.x > this.solvePlane(rightPlane, 'x', corner) + 1
				})
			})
		}

		body.addEventListener('collide', onCollide)
		bodies.forEach(die => die.addEventListener('collide', onAnyCollide))
		this.world.addEventListener('postStep', onPostStep)
		this.iterationLimit = this.presimStepLimit
		try {
			this.simulateThrow()
		} finally {
			body.removeEventListener('collide', onCollide)
			bodies.forEach(die => die.removeEventListener('collide', onAnyCollide))
			this.world.removeEventListener('postStep', onPostStep)
		}

		// the red die has to lie flat on the floor, not on another die; decorative ones may lean on each other.
		// Neither may be stopped abruptly while still spinning.
		const finished = this.iteration <= this.presimStepLimit
		const stopsSmoothly = i => report.lastSpin[i] < 1

		report.steps = this.iteration
		report.value = this.die.getLastValue().value
		report.settled = finished && stopsSmoothly(0) && this.topFaceTilt(body) < 0.15 && body.position.z < half * 1.1
		report.decorSettled = finished && bodies.every((die, i) => stopsSmoothly(i))
		report.visible = !report.offscreen && bodies.every(die => die.position.x >= this.visibleLeftX(die.position.y, die.position.z, half * Math.SQRT2))
		report.restX = new THREE.Vector3().copy(body.position).project(this.camera).x
		report.centered = Math.abs(report.restX) <= this.restZone

		// the red die has to land on the floor first, hit the right wall while airborne and land again
		const hits = report.sequence.filter(name => name === 'floor' || name === 'right')
			.filter((name, i, list) => name !== list[i - 1])
		report.collisionsOk = hits[0] === 'floor' && hits[1] === 'right' && hits[2] === 'floor'
			&& report.airborneWallHit && !report.touchedLimits

		report.valid = report.settled && report.decorSettled && report.visible && report.collisionsOk && report.centered
		return report
	}

	// Unlike DiceBox, nothing changes until all dice are asleep. A die frozen early would react differently
	// to a hit from another die, and the replay checks this every frame, not every step as the pre-simulation.
	throwFinished() {
		const asleep = this.diceList.every(die => die.body.sleepState === CANNON.Body.SLEEPING)
		if (!asleep && this.iteration <= this.iterationLimit) return false

		this.diceList.forEach(die => {
			if (die.body.type === CANNON.Body.KINEMATIC) return
			if (die.result.length === 0) die.storeRolledValue(die.resultReason)
			die.body.type = CANNON.Body.KINEMATIC
		})
		return true
	}

	// angle between the up axis and the closest face normal of a cube
	topFaceTilt(body) {
		const up = body.quaternion.inverse().vmult(new CANNON.Vec3(0, 0, 1))
		const cos = Math.max(Math.abs(up.x), Math.abs(up.y), Math.abs(up.z))
		return Math.acos(Math.min(1, cos))
	}

	async findThrow(token) {
		let fallback = null
		for (let attempt = 0; attempt < this.maxThrowAttempts; attempt++) {
			// keep the page responsive if several throws get rejected
			if (attempt > 0) await nextTask()
			if (this.activeRoll !== token) throw abortError()

			const vectors = this.generateThrow()
			const report = this.presimulate(vectors)
			report.attempts = attempt + 1
			this.lastReport = report
			this.learnFromThrow(report)

			if (report.valid) return { vectors, report }
			if (report.settled) {
				// prefer the full collision sequence, then neatly landed decorative dice, then the stop closest to the center
				report.score = (report.collisionsOk && report.visible ? 0 : 10) + (report.decorSettled ? 0 : 5) + Math.abs(report.restX)
				if (!fallback || report.score < fallback.report.score) fallback = { vectors, report }
			}
		}
		// a throw where the red die lands flat still guarantees the result, even without the full collision sequence
		if (fallback) return fallback
		throw new Error('Unable to simulate a throw that lands flat')
	}

	// A stronger throw bounces back from the wall further: throw harder if the die stopped right of the center
	// and softer if it stopped left of it.
	learnFromThrow(report) {
		if (!report.settled || !report.collisionsOk) return
		const error = Math.max(-1, Math.min(1, report.restX / 0.5))
		this.throwBoost = Math.max(0.6, Math.min(2, this.throwBoost * (1 + 0.15 * error)))
	}

	// Remaps the labels so the face that landed on top shows the result.
	// The labels are rotated as a rigid cube, so opposite faces keep adding up to 7.
	swapDiceFace(dicemesh, result) {
		if (dicemesh.shape !== 'd6') return super.swapDiceFace(dicemesh, result)

		const value = parseInt(dicemesh.getLastValue().value)
		result = parseInt(result)
		dicemesh.resultReason = 'forced'
		dicemesh.result = []
		if (value === result) return

		const geom = dicemesh.geometry
		const normals = geom.getAttribute('normal')
		// face materials start at index 2, see DiceFactory.getFaceValue
		const faceGroups = geom.groups.filter(group => group.materialIndex >= 2)
		const faceDirection = group => new THREE.Vector3().fromBufferAttribute(normals, group.start).round()

		const materialByDirection = new Map()
		let from, to
		faceGroups.forEach(group => {
			const direction = faceDirection(group)
			materialByDirection.set(directionKey(direction), group.materialIndex)
			if (group.materialIndex === value + 1) from = direction
			if (group.materialIndex === result + 1) to = direction
		})
		if (!from || !to) return

		const rotation = new THREE.Quaternion().setFromUnitVectors(from, to)
		// random quarter turn around the result face for some variety on the side faces
		rotation.premultiply(new THREE.Quaternion().setFromAxisAngle(to, Math.floor(Math.random() * 4) * Math.PI / 2))

		faceGroups.forEach(group => {
			const source = faceDirection(group).applyQuaternion(rotation).round()
			group.materialIndex = materialByDirection.get(directionKey(source))
		})
	}

	animateRoll(token) {
		return new Promise((resolve, reject) => {
			token.reject = reject
			this.iterationLimit = Infinity
			this.rolling = true
			this.running = ++this.rollCounter
			this.last_time = 0
			this.animateThrow(this.running, () => {
				token.reject = null
				resolve(this.die.getLastValue().value)
			})
		})
	}

	async roll(value) {
		value = Number(value)
		if (!Number.isInteger(value) || value < 1 || value > 6) {
			throw new RangeError(`Roll value must be an integer from 1 to 6, got ${value}`)
		}
		if (!this.initialized) throw new Error('DiceBox is not initialized')
		if (this.activeRoll) throw new Error('A roll is already in progress')
		if (!this.bounds) throw new Error('Dice container has no size')

		const token = {}
		this.activeRoll = token
		try {
			if (!this.die) this.createDice()
			this.resetFaceLayout(this.die)

			const { vectors, report } = await this.findThrow(token)
			if (this.activeRoll !== token) throw abortError()

			// reset the simulation and replay the same throw on screen
			this.resetDice(vectors)
			this.die.result = [{ value: report.value }]
			this.swapDiceFace(this.die, value)
			this.diceList.forEach(die => {
				if (!die.parent) this.scene.add(die)
			})

			const result = await this.animateRoll(token)
			if (result !== value) console.warn(`Expected ${value} but the die shows ${result}`)
			return result
		} catch (error) {
			// the body is left in a pre-simulated state, nothing valid to show
			if (this.activeRoll === token) this.clearDice()
			throw error
		} finally {
			if (this.activeRoll === token) {
				this.activeRoll = null
				this.rolling = false
				if (this.pendingBounds) this.makeWorldBox()
			}
		}
	}

	clearDice() {
		this.running = false
		this.rolling = false
		this.diceList.forEach(die => {
			if (die.body) this.world.removeBody(die.body)
			die.body = null
			this.scene.remove(die)
		})
		if (this.renderer) this.renderer.render(this.scene, this.camera)
	}

	// stops the current roll (its promise rejects with an AbortError) and removes the dice
	reset() {
		const roll = this.activeRoll
		this.activeRoll = null
		this.clearDice()
		if (roll && roll.reject) roll.reject(abortError())
		if (this.pendingBounds) this.makeWorldBox()
	}

	destroy() {
		this.reset()

		if (this.resizeObserver) this.resizeObserver.disconnect()
		if (this.onWindowResize) window.removeEventListener('resize', this.onWindowResize)
		this.resizeObserver = null
		this.onWindowResize = null

		Object.values(this.box_body).forEach(body => this.world.removeBody(body))
		this.box_body = {}
		this.boundaryNames.clear()

		this.diceList.forEach(die => {
			die.geometry.dispose()
			die.material.forEach(material => material.dispose())
		})
		this.die = null
		this.decorDice = []
		this.diceList = []
		Object.values(this.DiceFactory.geometries).forEach(geometry => geometry.dispose())
		this.DiceFactory.geometries = {}
		Object.values(this.DiceFactory.materials_cache).forEach(({ composite, bump }) => {
			if (composite) composite.dispose()
			if (bump) bump.dispose()
		})
		this.DiceFactory.materials_cache = {}

		this.scene.clear()
		this.light = null
		this.light_amb = null

		if (this.renderer) {
			this.renderer.dispose()
			this.renderer.forceContextLoss()
			this.renderer.domElement.remove()
			this.renderer = null
		}
		this.initialized = false
	}
}

export { D6RollBox }
