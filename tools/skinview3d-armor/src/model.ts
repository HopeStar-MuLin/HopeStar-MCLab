import type { ModelType } from "skinview-utils";
import {
	BoxGeometry,
	BufferAttribute,
	DoubleSide,
	FrontSide,
	Group,
	Mesh,
	MeshStandardMaterial,
	Object3D,
	Texture,
	Vector2,
} from "three";

function setUVs(
	box: BoxGeometry,
	u: number,
	v: number,
	width: number,
	height: number,
	depth: number,
	textureWidth: number,
	textureHeight: number
): void {
	const toFaceVertices = (x1: number, y1: number, x2: number, y2: number) => [
		new Vector2(x1 / textureWidth, 1.0 - y2 / textureHeight),
		new Vector2(x2 / textureWidth, 1.0 - y2 / textureHeight),
		new Vector2(x2 / textureWidth, 1.0 - y1 / textureHeight),
		new Vector2(x1 / textureWidth, 1.0 - y1 / textureHeight),
	];

	const top = toFaceVertices(u + depth, v, u + width + depth, v + depth);
	const bottom = toFaceVertices(u + width + depth, v, u + width * 2 + depth, v + depth);
	const left = toFaceVertices(u, v + depth, u + depth, v + depth + height);
	const front = toFaceVertices(u + depth, v + depth, u + width + depth, v + depth + height);
	const right = toFaceVertices(u + width + depth, v + depth, u + width + depth * 2, v + height + depth);
	const back = toFaceVertices(u + width + depth * 2, v + depth, u + width * 2 + depth * 2, v + height + depth);

	const uvAttr = box.attributes.uv as BufferAttribute;
	const uvRight = [right[3], right[2], right[0], right[1]];
	const uvLeft = [left[3], left[2], left[0], left[1]];
	const uvTop = [top[3], top[2], top[0], top[1]];
	const uvBottom = [bottom[0], bottom[1], bottom[3], bottom[2]];
	const uvFront = [front[3], front[2], front[0], front[1]];
	const uvBack = [back[3], back[2], back[0], back[1]];

	// Create a new array to hold the modified UV data
	const newUVData = [];

	// Iterate over the arrays and copy the data to uvData
	for (const uvArray of [uvRight, uvLeft, uvTop, uvBottom, uvFront, uvBack]) {
		for (const uv of uvArray) {
			newUVData.push(uv.x, uv.y);
		}
	}

	uvAttr.set(new Float32Array(newUVData));
	uvAttr.needsUpdate = true;
}

function setSkinUVs(box: BoxGeometry, u: number, v: number, width: number, height: number, depth: number): void {
	setUVs(box, u, v, width, height, depth, 64, 64);
}

function setCapeUVs(box: BoxGeometry, u: number, v: number, width: number, height: number, depth: number): void {
	setUVs(box, u, v, width, height, depth, 64, 32);
}

/**
 * 盔甲材质的贴图是 64x32（老版肤色贴图的上半张），
 * 而且 UV 是按**没膨胀**的盒子切的 —— 盒子本身比皮肤大 2 个单位，
 * 贴图就被拉伸，这点和原版 HumanoidArmorLayer 一致。
 */
function setArmorUVs(box: BoxGeometry, u: number, v: number, width: number, height: number, depth: number): void {
	setUVs(box, u, v, width, height, depth, 64, 32);
}

/// 四个装备槽。每个槽可以穿不同材质的盔甲，互不影响。
export type ArmorSlot = "helmet" | "chest" | "legs" | "boots";

/// 盔甲材质：单面画（头盔正面挖了口，双面会看到内壁），
/// 带 alpha（靴子只画脚那段），所以必须 transparent + alphaTest。
function createArmorMaterial(): MeshStandardMaterial {
	return new MeshStandardMaterial({
		side: FrontSide,
		transparent: true,
		alphaTest: 1e-5,
	});
}

/** 每件护甲在材质贴图上的位置。数值取自原版 `HumanoidArmorLayer#createArmorLayer`。 */
const ARMOR_UV = {
	helmet: [0, 0, 8, 8, 8],
	chestBody: [16, 16, 8, 12, 4],
	arm: [40, 16, 4, 12, 4],
	leggingBody: [16, 16, 8, 12, 4],
	leggingLeg: [0, 16, 4, 12, 4],
	boot: [0, 16, 4, 12, 4],
} as const;

/**
 * 膨胀量（每个面各外扩多少）。原版头盔/胸甲/靴子用 1.0，护腿用 0.5，
 * 所以画面里护甲比皮肤明显厚一圈，护腿贴得更紧。
 */
const ARMOR_INFLATE_OUTER = 1.0;
const ARMOR_INFLATE_INNER = 0.5;

/**
 * Notice that innerLayer and outerLayer may NOT be the direct children of the Group.
 */
export class BodyPart extends Group {
	constructor(
		readonly innerLayer: Object3D,
		readonly outerLayer: Object3D
	) {
		super();
		innerLayer.name = "inner";
		outerLayer.name = "outer";
	}
}

export class SkinObject extends Group {
	// body parts
	readonly head: BodyPart;
	readonly body: BodyPart;
	readonly rightArm: BodyPart;
	readonly leftArm: BodyPart;
	readonly rightLeg: BodyPart;
	readonly leftLeg: BodyPart;

	private modelListeners: Array<() => void> = []; // called when model(slim property) is changed
	private slim = false;

	private _map: Texture | null = null;
	private layer1Material: MeshStandardMaterial;
	private layer1MaterialBiased: MeshStandardMaterial;
	private layer2Material: MeshStandardMaterial;
	private layer2MaterialBiased: MeshStandardMaterial;

	// ---- 盔甲 ----
	// 四个槽各一个材质，才能混搭（头盔钻石、胸甲皮革、护腿铁、靴子金）。
	// 贴图还是原版那两张：头盔/胸甲/靴子取 layer_1，护腿取 layer_2，
	// 只是现在每件可以来自不同材质的图。
	private armorMaterials: Record<ArmorSlot, MeshStandardMaterial>;
	/** 所有盔甲网格；每个网格的 userData.armorSlot 指向它属于哪个槽 */
	private armorMeshes: Mesh[] = [];
	/** 瘦手臂要跟着模型类型改宽度，参考皮肤那条 listener 的做法 */
	private armorModelListeners: Array<() => void> = [];

	/// 手臂护甲的高度，按 1.21.1 的模型来：4x5x4，只覆盖上臂。
	///
	/// <p>1.20.5 重做装备渲染时把这块从 4x12x4（整条手臂）缩短了，
	/// 贴图上也看得出来 —— 现在 `layer_1` 的手臂区域只有 9 行有内容
	/// （4 行顶/底 + 5 行侧面）。这里不再做版本分支，钉死一个基准。
	private armorArmHeight = 5;

	constructor() {
		super();

		this.layer1Material = new MeshStandardMaterial({
			side: FrontSide,
		});
		this.layer2Material = new MeshStandardMaterial({
			side: DoubleSide,
			transparent: true,
			alphaTest: 1e-5,
		});

		this.layer1MaterialBiased = this.layer1Material.clone();
		this.layer1MaterialBiased.polygonOffset = true;
		this.layer1MaterialBiased.polygonOffsetFactor = 1.0;
		this.layer1MaterialBiased.polygonOffsetUnits = 1.0;

		this.layer2MaterialBiased = this.layer2Material.clone();
		this.layer2MaterialBiased.polygonOffset = true;
		this.layer2MaterialBiased.polygonOffsetFactor = 1.0;
		this.layer2MaterialBiased.polygonOffsetUnits = 1.0;

		this.armorMaterials = {
			helmet: createArmorMaterial(),
			chest: createArmorMaterial(),
			legs: createArmorMaterial(),
			boots: createArmorMaterial(),
		};

		// Head
		const headBox = new BoxGeometry(8, 8, 8);
		setSkinUVs(headBox, 0, 0, 8, 8, 8);
		const headMesh = new Mesh(headBox, this.layer1Material);

		const head2Box = new BoxGeometry(9, 9, 9);
		setSkinUVs(head2Box, 32, 0, 8, 8, 8);
		const head2Mesh = new Mesh(head2Box, this.layer2Material);

		this.head = new BodyPart(headMesh, head2Mesh);
		this.head.name = "head";
		this.head.add(headMesh, head2Mesh);
		headMesh.position.y = 4;
		head2Mesh.position.y = 4;

		// 头盔：8x8x8 外扩 1 → 10x10x10，位置和头一样（y=4）
		const helmetBox = new BoxGeometry(8 + ARMOR_INFLATE_OUTER * 2, 8 + ARMOR_INFLATE_OUTER * 2, 8 + ARMOR_INFLATE_OUTER * 2);
		setArmorUVs(helmetBox, ...ARMOR_UV.helmet);
		const helmetMesh = new Mesh(helmetBox, this.armorMaterials.helmet);
		helmetMesh.name = "armorHelmet";
		helmetMesh.userData.armorSlot = "helmet";
		helmetMesh.visible = false;
		helmetMesh.position.y = 4;
		this.armorMeshes.push(helmetMesh);
		this.head.add(helmetMesh);

		this.add(this.head);

		// Body
		const bodyBox = new BoxGeometry(8, 12, 4);
		setSkinUVs(bodyBox, 16, 16, 8, 12, 4);
		const bodyMesh = new Mesh(bodyBox, this.layer1Material);

		const body2Box = new BoxGeometry(8.5, 12.5, 4.5);
		setSkinUVs(body2Box, 16, 32, 8, 12, 4);
		const body2Mesh = new Mesh(body2Box, this.layer2Material);

		this.body = new BodyPart(bodyMesh, body2Mesh);
		this.body.name = "body";
		this.body.add(bodyMesh, body2Mesh);
		this.body.position.y = -6;

		// 胸甲躯干：8x12x4 外扩 1 → 10x14x6
		const chestBox = new BoxGeometry(8 + ARMOR_INFLATE_OUTER * 2, 12 + ARMOR_INFLATE_OUTER * 2, 4 + ARMOR_INFLATE_OUTER * 2);
		setArmorUVs(chestBox, ...ARMOR_UV.chestBody);
		const chestMesh = new Mesh(chestBox, this.armorMaterials.chest);
		chestMesh.name = "armorChest";
		chestMesh.userData.armorSlot = "chest";
		chestMesh.visible = false;
		this.armorMeshes.push(chestMesh);
		this.body.add(chestMesh);

		// 护腿的腰带那段：外扩 0.5 → 9x13x5，比胸甲瘦一圈，正好套在皮肤外面
		const leggingBodyBox = new BoxGeometry(8 + ARMOR_INFLATE_INNER * 2, 12 + ARMOR_INFLATE_INNER * 2, 4 + ARMOR_INFLATE_INNER * 2);
		setArmorUVs(leggingBodyBox, ...ARMOR_UV.leggingBody);
		const leggingBodyMesh = new Mesh(leggingBodyBox, this.armorMaterials.legs);
		leggingBodyMesh.name = "armorLeggingBody";
		leggingBodyMesh.userData.armorSlot = "legs";
		leggingBodyMesh.visible = false;
		this.armorMeshes.push(leggingBodyMesh);
		this.body.add(leggingBodyMesh);

		this.add(this.body);

		// Right Arm
		const rightArmBox = new BoxGeometry();
		const rightArmMesh = new Mesh(rightArmBox, this.layer1MaterialBiased);
		this.modelListeners.push(() => {
			rightArmMesh.scale.x = this.slim ? 3 : 4;
			rightArmMesh.scale.y = 12;
			rightArmMesh.scale.z = 4;
			setSkinUVs(rightArmBox, 40, 16, this.slim ? 3 : 4, 12, 4);
		});

		const rightArm2Box = new BoxGeometry();
		const rightArm2Mesh = new Mesh(rightArm2Box, this.layer2MaterialBiased);
		this.modelListeners.push(() => {
			rightArm2Mesh.scale.x = this.slim ? 3.5 : 4.5;
			rightArm2Mesh.scale.y = 12.5;
			rightArm2Mesh.scale.z = 4.5;
			setSkinUVs(rightArm2Box, 40, 32, this.slim ? 3 : 4, 12, 4);
		});

		const rightArmPivot = new Group();
		rightArmPivot.add(rightArmMesh, rightArm2Mesh);

		// 胸甲的袖子：手臂盒子外扩 1，瘦模型时跟着窄 1
		const rightArmArmorBox = new BoxGeometry();
		const rightArmArmorMesh = new Mesh(rightArmArmorBox, this.armorMaterials.chest);
		rightArmArmorMesh.name = "armorRightArm";
		rightArmArmorMesh.userData.armorSlot = "chest";
		rightArmArmorMesh.visible = false;
		this.armorMeshes.push(rightArmArmorMesh);
		this.modelListeners.push(() => {
			const w = (this.slim ? 3 : 4) + ARMOR_INFLATE_OUTER * 2;
			const h = this.armorArmHeight;
			// 深度比胸甲多 0.2：袖子和胸甲的前后表面本来正好都在 z=±3，
			// 共面会闪（z-fighting）。多出来这 0.1 让袖子稳定地盖在胸甲上，
			// 视觉上看不出来。
			rightArmArmorMesh.scale.set(w, h + ARMOR_INFLATE_OUTER * 2, 4 + ARMOR_INFLATE_OUTER * 2 + 0.2);
			// 短的那版要贴着肩膀放（手臂网格 12 高，+6 是顶端）；整条那种居中
			rightArmArmorMesh.position.y = h >= 12 ? 0 : 6 - h / 2;
			setArmorUVs(rightArmArmorBox, ARMOR_UV.arm[0], ARMOR_UV.arm[1], this.slim ? 3 : 4, h, ARMOR_UV.arm[4]);
		});
		rightArmPivot.add(rightArmArmorMesh);

		this.modelListeners.push(() => {
			rightArmPivot.position.x = this.slim ? -0.5 : -1;
		});
		rightArmPivot.position.y = -4;

		this.rightArm = new BodyPart(rightArmMesh, rightArm2Mesh);
		this.rightArm.name = "rightArm";
		this.rightArm.add(rightArmPivot);
		this.rightArm.position.x = -5;
		this.rightArm.position.y = -2;
		this.add(this.rightArm);

		// Left Arm
		const leftArmBox = new BoxGeometry();
		const leftArmMesh = new Mesh(leftArmBox, this.layer1MaterialBiased);
		this.modelListeners.push(() => {
			leftArmMesh.scale.x = this.slim ? 3 : 4;
			leftArmMesh.scale.y = 12;
			leftArmMesh.scale.z = 4;
			setSkinUVs(leftArmBox, 32, 48, this.slim ? 3 : 4, 12, 4);
		});

		const leftArm2Box = new BoxGeometry();
		const leftArm2Mesh = new Mesh(leftArm2Box, this.layer2MaterialBiased);
		this.modelListeners.push(() => {
			leftArm2Mesh.scale.x = this.slim ? 3.5 : 4.5;
			leftArm2Mesh.scale.y = 12.5;
			leftArm2Mesh.scale.z = 4.5;
			setSkinUVs(leftArm2Box, 48, 48, this.slim ? 3 : 4, 12, 4);
		});

		const leftArmPivot = new Group();
		leftArmPivot.add(leftArmMesh, leftArm2Mesh);

		const leftArmArmorBox = new BoxGeometry();
		const leftArmArmorMesh = new Mesh(leftArmArmorBox, this.armorMaterials.chest);
		leftArmArmorMesh.name = "armorLeftArm";
		leftArmArmorMesh.userData.armorSlot = "chest";
		leftArmArmorMesh.visible = false;
		this.armorMeshes.push(leftArmArmorMesh);
		this.modelListeners.push(() => {
			const w = (this.slim ? 3 : 4) + ARMOR_INFLATE_OUTER * 2;
			const h = this.armorArmHeight;
			leftArmArmorMesh.scale.set(w, h + ARMOR_INFLATE_OUTER * 2, 4 + ARMOR_INFLATE_OUTER * 2 + 0.2);
			leftArmArmorMesh.position.y = h >= 12 ? 0 : 6 - h / 2;
			setArmorUVs(leftArmArmorBox, ARMOR_UV.arm[0], ARMOR_UV.arm[1], this.slim ? 3 : 4, h, ARMOR_UV.arm[4]);
		});
		leftArmPivot.add(leftArmArmorMesh);

		this.modelListeners.push(() => {
			leftArmPivot.position.x = this.slim ? 0.5 : 1;
		});
		leftArmPivot.position.y = -4;

		this.leftArm = new BodyPart(leftArmMesh, leftArm2Mesh);
		this.leftArm.name = "leftArm";
		this.leftArm.add(leftArmPivot);
		this.leftArm.position.x = 5;
		this.leftArm.position.y = -2;
		this.add(this.leftArm);

		// Right Leg
		const rightLegBox = new BoxGeometry(4, 12, 4);
		setSkinUVs(rightLegBox, 0, 16, 4, 12, 4);
		const rightLegMesh = new Mesh(rightLegBox, this.layer1MaterialBiased);

		const rightLeg2Box = new BoxGeometry(4.5, 12.5, 4.5);
		setSkinUVs(rightLeg2Box, 0, 32, 4, 12, 4);
		const rightLeg2Mesh = new Mesh(rightLeg2Box, this.layer2MaterialBiased);

		const rightLegPivot = new Group();
		rightLegPivot.add(rightLegMesh, rightLeg2Mesh);
		rightLegPivot.position.y = -6;

		const rightLeggingBox = new BoxGeometry(4 + ARMOR_INFLATE_INNER * 2, 12 + ARMOR_INFLATE_INNER * 2, 4 + ARMOR_INFLATE_INNER * 2);
		setArmorUVs(rightLeggingBox, ...ARMOR_UV.leggingLeg);
		const rightLeggingMesh = new Mesh(rightLeggingBox, this.armorMaterials.legs);
		rightLeggingMesh.name = "armorRightLegging";
		rightLeggingMesh.userData.armorSlot = "legs";
		rightLeggingMesh.visible = false;
		this.armorMeshes.push(rightLeggingMesh);
		rightLegPivot.add(rightLeggingMesh);

		// 靴子用整条腿的盒子，贴图只画了脚那一段，上面靠 alpha 透掉 —— 原版就是这么干的
		const rightBootBox = new BoxGeometry(4 + ARMOR_INFLATE_OUTER * 2, 12 + ARMOR_INFLATE_OUTER * 2, 4 + ARMOR_INFLATE_OUTER * 2);
		setArmorUVs(rightBootBox, ...ARMOR_UV.boot);
		const rightBootMesh = new Mesh(rightBootBox, this.armorMaterials.boots);
		rightBootMesh.name = "armorRightBoot";
		rightBootMesh.userData.armorSlot = "boots";
		rightBootMesh.visible = false;
		this.armorMeshes.push(rightBootMesh);
		rightLegPivot.add(rightBootMesh);

		this.rightLeg = new BodyPart(rightLegMesh, rightLeg2Mesh);
		this.rightLeg.name = "rightLeg";
		this.rightLeg.add(rightLegPivot);
		this.rightLeg.position.x = -1.9;
		this.rightLeg.position.y = -12;
		this.rightLeg.position.z = -0.1;
		this.add(this.rightLeg);

		// Left Leg
		const leftLegBox = new BoxGeometry(4, 12, 4);
		setSkinUVs(leftLegBox, 16, 48, 4, 12, 4);
		const leftLegMesh = new Mesh(leftLegBox, this.layer1MaterialBiased);

		const leftLeg2Box = new BoxGeometry(4.5, 12.5, 4.5);
		setSkinUVs(leftLeg2Box, 0, 48, 4, 12, 4);
		const leftLeg2Mesh = new Mesh(leftLeg2Box, this.layer2MaterialBiased);

		const leftLegPivot = new Group();
		leftLegPivot.add(leftLegMesh, leftLeg2Mesh);
		leftLegPivot.position.y = -6;

		const leftLeggingBox = new BoxGeometry(4 + ARMOR_INFLATE_INNER * 2, 12 + ARMOR_INFLATE_INNER * 2, 4 + ARMOR_INFLATE_INNER * 2);
		setArmorUVs(leftLeggingBox, ...ARMOR_UV.leggingLeg);
		const leftLeggingMesh = new Mesh(leftLeggingBox, this.armorMaterials.legs);
		leftLeggingMesh.name = "armorLeftLegging";
		leftLeggingMesh.userData.armorSlot = "legs";
		leftLeggingMesh.visible = false;
		this.armorMeshes.push(leftLeggingMesh);
		leftLegPivot.add(leftLeggingMesh);

		const leftBootBox = new BoxGeometry(4 + ARMOR_INFLATE_OUTER * 2, 12 + ARMOR_INFLATE_OUTER * 2, 4 + ARMOR_INFLATE_OUTER * 2);
		setArmorUVs(leftBootBox, ...ARMOR_UV.boot);
		const leftBootMesh = new Mesh(leftBootBox, this.armorMaterials.boots);
		leftBootMesh.name = "armorLeftBoot";
		leftBootMesh.userData.armorSlot = "boots";
		leftBootMesh.visible = false;
		this.armorMeshes.push(leftBootMesh);
		leftLegPivot.add(leftBootMesh);

		this.leftLeg = new BodyPart(leftLegMesh, leftLeg2Mesh);
		this.leftLeg.name = "leftLeg";
		this.leftLeg.add(leftLegPivot);
		this.leftLeg.position.x = 1.9;
		this.leftLeg.position.y = -12;
		this.leftLeg.position.z = -0.1;
		this.add(this.leftLeg);

		this.modelType = "default";
	}

	get map(): Texture | null {
		return this._map;
	}

	set map(newMap: Texture | null) {
		this._map = newMap;

		this.layer1Material.map = newMap;
		this.layer1Material.needsUpdate = true;

		this.layer1MaterialBiased.map = newMap;
		this.layer1MaterialBiased.needsUpdate = true;

		this.layer2Material.map = newMap;
		this.layer2Material.needsUpdate = true;

		this.layer2MaterialBiased.map = newMap;
		this.layer2MaterialBiased.needsUpdate = true;
	}

	/// 给某个槽换贴图。传 `null` 就是把这个部位脱掉。
	///
	/// 槽和部位的对应：`helmet` 头盔、`chest` 胸甲 + 两只袖子、
	/// `legs` 护腿（腰带 + 两条腿）、`boots` 两只靴子。
	setArmorTexture(slot: ArmorSlot, texture: Texture | null): void {
		const material = this.armorMaterials[slot];
		material.map = texture;
		material.needsUpdate = true;
		for (const mesh of this.armorMeshes) {
			if (mesh.userData.armorSlot === slot) {
				mesh.visible = texture !== null;
			}
		}
	}

	/// 手臂护甲用哪一版的尺寸：5 = 1.21.1（上臂，默认），12 = 1.20.4 及更早（整条手臂）。
	setArmorArmHeight(height: number): void {
		const next = height > 0 ? height : 5;
		if (this.armorArmHeight === next) {
			return;
		}
		this.armorArmHeight = next;
		this.modelListeners.forEach(listener => listener());
	}

	get modelType(): ModelType {
		return this.slim ? "slim" : "default";
	}

	set modelType(value: ModelType) {
		this.slim = value === "slim";
		this.modelListeners.forEach(listener => listener());
	}

	private getBodyParts(): Array<BodyPart> {
		return this.children.filter(it => it instanceof BodyPart) as Array<BodyPart>;
	}

	setInnerLayerVisible(value: boolean): void {
		this.getBodyParts().forEach(part => (part.innerLayer.visible = value));
	}

	setOuterLayerVisible(value: boolean): void {
		this.getBodyParts().forEach(part => (part.outerLayer.visible = value));
	}

	resetJoints(): void {
		this.head.rotation.set(0, 0, 0);
		this.leftArm.rotation.set(0, 0, 0);
		this.rightArm.rotation.set(0, 0, 0);
		this.leftLeg.rotation.set(0, 0, 0);
		this.rightLeg.rotation.set(0, 0, 0);
		this.body.rotation.set(0, 0, 0);
		this.head.position.y = 0;
		this.body.position.y = -6;
		this.body.position.z = 0;
		this.rightArm.position.x = -5;
		this.rightArm.position.y = -2;
		this.rightArm.position.z = 0;
		this.leftArm.position.x = 5;
		this.leftArm.position.y = -2;
		this.leftArm.position.z = 0;
		this.rightLeg.position.x = -1.9;
		this.rightLeg.position.y = -12;
		this.rightLeg.position.z = -0.1;
		this.leftLeg.position.x = 1.9;
		this.leftLeg.position.y = -12;
		this.leftLeg.position.z = -0.1;
	}
}

export class CapeObject extends Group {
	readonly cape: Mesh;

	private material: MeshStandardMaterial;

	constructor() {
		super();

		this.material = new MeshStandardMaterial({
			side: DoubleSide,
			transparent: true,
			alphaTest: 1e-5,
		});

		// +z (front) - inside of cape
		// -z (back) - outside of cape
		const capeBox = new BoxGeometry(10, 16, 1);
		setCapeUVs(capeBox, 0, 0, 10, 16, 1);
		this.cape = new Mesh(capeBox, this.material);
		this.cape.position.y = -8;
		this.cape.position.z = 0.5;
		this.add(this.cape);
	}

	get map(): Texture | null {
		return this.material.map;
	}

	set map(newMap: Texture | null) {
		this.material.map = newMap;
		this.material.needsUpdate = true;
	}
}

export class ElytraObject extends Group {
	readonly leftWing: Group;
	readonly rightWing: Group;

	private material: MeshStandardMaterial;

	constructor() {
		super();

		this.material = new MeshStandardMaterial({
			side: DoubleSide,
			transparent: true,
			alphaTest: 1e-5,
		});

		// 几何体必须和 UV 参数严格同尺寸（10x20x2）。
		// 之前是 12x22x4 却按 10x20x2 切 UV —— 每个面拿到的纹理区域和面的
		// 实际宽度/高度不成比例，侧面（4 厚）用的是 2 厚那条、顶底（12x4）
		// 用的是 10x2 那块，图案被拉得七扭八歪，看上去像「建模和贴图分家了」。
		// 原版 ElytraModel 就是 addBox(-10, 0, 0, 10, 20, 2) + UV (22,0)。
		const leftWingBox = new BoxGeometry(10, 20, 2);
		setCapeUVs(leftWingBox, 22, 0, 10, 20, 2);
		const leftWingMesh = new Mesh(leftWingBox, this.material);
		// 右边缘贴住身体（x=0），顶边齐肩（y=0），厚度居中在背后
		leftWingMesh.position.x = -5;
		leftWingMesh.position.y = -10;
		leftWingMesh.position.z = -1;
		this.leftWing = new Group();
		this.leftWing.add(leftWingMesh);
		this.add(this.leftWing);

		const rightWingBox = new BoxGeometry(10, 20, 2);
		setCapeUVs(rightWingBox, 22, 0, 10, 20, 2);
		const rightWingMesh = new Mesh(rightWingBox, this.material);
		rightWingMesh.scale.x = -1;
		rightWingMesh.position.x = 5;
		rightWingMesh.position.y = -10;
		rightWingMesh.position.z = -1;
		this.rightWing = new Group();
		this.rightWing.add(rightWingMesh);
		this.add(this.rightWing);

		this.leftWing.position.x = 5;
		this.leftWing.rotation.x = 0.2617994;
		this.resetJoints();
	}

	resetJoints(): void {
		this.leftWing.rotation.y = 0.01; // to avoid z-fighting
		this.leftWing.rotation.z = 0.2617994;
		this.updateRightWing();
	}

	/**
	 * Mirrors the position & rotation of left wing,
	 * and apply them to the right wing.
	 */
	updateRightWing(): void {
		this.rightWing.position.x = -this.leftWing.position.x;
		this.rightWing.position.y = this.leftWing.position.y;
		this.rightWing.rotation.x = this.leftWing.rotation.x;
		this.rightWing.rotation.y = -this.leftWing.rotation.y;
		this.rightWing.rotation.z = -this.leftWing.rotation.z;
	}

	get map(): Texture | null {
		return this.material.map;
	}

	set map(newMap: Texture | null) {
		this.material.map = newMap;
		this.material.needsUpdate = true;
	}
}

export class EarsObject extends Group {
	readonly rightEar: Mesh;
	readonly leftEar: Mesh;

	private material: MeshStandardMaterial;

	constructor() {
		super();

		this.material = new MeshStandardMaterial({
			side: FrontSide,
		});
		const earBox = new BoxGeometry(8, 8, 4 / 3);
		setUVs(earBox, 0, 0, 6, 6, 1, 14, 7);

		this.rightEar = new Mesh(earBox, this.material);
		this.rightEar.name = "rightEar";
		this.rightEar.position.x = -6;
		this.add(this.rightEar);

		this.leftEar = new Mesh(earBox, this.material);
		this.leftEar.name = "leftEar";
		this.leftEar.position.x = 6;
		this.add(this.leftEar);
	}

	get map(): Texture | null {
		return this.material.map;
	}

	set map(newMap: Texture | null) {
		this.material.map = newMap;
		this.material.needsUpdate = true;
	}
}

export type BackEquipment = "cape" | "elytra";

const CapeDefaultAngle = (10.8 * Math.PI) / 180;

export class PlayerObject extends Group {
	readonly skin: SkinObject;
	readonly cape: CapeObject;
	readonly elytra: ElytraObject;
	readonly ears: EarsObject;

	constructor() {
		super();

		this.skin = new SkinObject();
		this.skin.name = "skin";
		this.skin.position.y = 8;
		this.add(this.skin);

		this.cape = new CapeObject();
		this.cape.name = "cape";
		this.cape.position.y = 8;
		this.cape.position.z = -2;
		this.cape.rotation.x = CapeDefaultAngle;
		this.cape.rotation.y = Math.PI;
		this.add(this.cape);

		this.elytra = new ElytraObject();
		this.elytra.name = "elytra";
		this.elytra.position.y = 8;
		this.elytra.position.z = -2;
		this.elytra.visible = false;
		this.add(this.elytra);

		this.ears = new EarsObject();
		this.ears.name = "ears";
		this.ears.position.y = 10;
		this.ears.position.z = 2 / 3;
		this.ears.visible = false;
		this.skin.head.add(this.ears);
	}

	get backEquipment(): BackEquipment | null {
		if (this.cape.visible) {
			return "cape";
		} else if (this.elytra.visible) {
			return "elytra";
		} else {
			return null;
		}
	}

	set backEquipment(value: BackEquipment | null) {
		this.cape.visible = value === "cape";
		this.elytra.visible = value === "elytra";
	}

	resetJoints(): void {
		this.skin.resetJoints();
		this.cape.rotation.x = CapeDefaultAngle;
		this.cape.position.y = 8;
		this.cape.position.z = -2;
		this.elytra.position.y = 8;
		this.elytra.position.z = -2;
		this.elytra.rotation.x = 0;
		this.elytra.resetJoints();
	}
}
