package org.jackhuang.hmcl.ui.skin;

import javafx.scene.*;
import javafx.scene.image.Image;
import javafx.scene.input.MouseEvent;
import javafx.scene.input.ScrollEvent;
import javafx.scene.paint.Color;
import javafx.scene.paint.Material;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.Shape3D;
import javafx.scene.transform.Rotate;
import javafx.scene.transform.Scale;
import javafx.scene.transform.Translate;

import org.jetbrains.annotations.Nullable;

public class SkinCanvas extends Group {

    public static final SkinCube ALEX_LARM = new SkinCube(3, 12, 4, 14F / 64F, 16F / 64F, 32F / 64F, 48F / 64F, 0F, true);
    public static final SkinCube ALEX_RARM = new SkinCube(3, 12, 4, 14F / 64F, 16F / 64F, 40F / 64F, 16F / 64F, 0F, true);

    public static final SkinCube STEVEN_LARM = new SkinCube(4, 12, 4, 16F / 64F, 16F / 64F, 32F / 64F, 48F / 64F, 0F, false);
    public static final SkinCube STEVEN_RARM = new SkinCube(4, 12, 4, 16F / 64F, 16F / 64F, 40F / 64F, 16F / 64F, 0F, false);

    protected Image srcSkin, skin, srcCape, cape;
    protected boolean isSlim;

    protected double preW, preH;
    protected boolean msaa;

    protected SubScene subScene;
    protected Group root = new Group();

    public final SkinMultipleCubes headOuter = new SkinMultipleCubes(8, 8, 8, 32F / 64F, 0F, 1.125, 0.2);
    public final SkinMultipleCubes bodyOuter = new SkinMultipleCubes(8, 12, 4, 16F / 64F, 32F / 64F, 1, 0.2);
    public final SkinMultipleCubes larmOuter = new SkinMultipleCubes(4, 12, 4, 48F / 64F, 48F / 64F, 1.0625, 0.2);
    public final SkinMultipleCubes rarmOuter = new SkinMultipleCubes(4, 12, 4, 40F / 64F, 32F / 64F, 1.0625, 0.2);
    public final SkinMultipleCubes llegOuter = new SkinMultipleCubes(4, 12, 4, 0F / 64F, 48F / 64F, 1.0625, 0.2);
    public final SkinMultipleCubes rlegOuter = new SkinMultipleCubes(4, 12, 4, 0F / 64F, 32F / 64F, 1.0625, 0.2);

    public final SkinCube headInside = new SkinCube(8, 8, 8, 32F / 64F, 16F / 64F, 0F, 0F, 0F, false);
    public final SkinCube bodyInside = new SkinCube(8, 12, 4, 24F / 64F, 16F / 64F, 16F / 64F, 16F / 64F, 0.03F, false);
    public final SkinCube larmInside = new SkinCube(4, 12, 4, 16F / 64F, 16F / 64F, 32F / 64F, 48F / 64F, 0F, false);
    public final SkinCube rarmInside = new SkinCube(4, 12, 4, 16F / 64F, 16F / 64F, 40F / 64F, 16F / 64F, 0F, false);
    public final SkinCube llegInside = new SkinCube(4, 12, 4, 16F / 64F, 16F / 64F, 16F / 64F, 48F / 64F, 0F, false);
    public final SkinCube rlegInside = new SkinCube(4, 12, 4, 16F / 64F, 16F / 64F, 0F, 16F / 64F, 0F, false);

    public final SkinCube capeCube = new SkinCube(10, 16, 1, 22F / 64F, 17F / 32F, 0F, 0F, 0F, false);

    public final SkinGroup head = new SkinGroup(
            new Rotate(0, 0, headInside.getHeight() / 2, 0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, 0, headInside.getHeight() / 2, 0, Rotate.Z_AXIS),
            headOuter, headInside
    );
    public final SkinGroup body = new SkinGroup(
            new Rotate(0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, Rotate.Z_AXIS),
            bodyOuter, bodyInside
    );
    public final SkinGroup larm = new SkinGroup(
            new Rotate(0, 0, -larmInside.getHeight() / 2, 0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, +larmInside.getWidth() / 2, -larmInside.getHeight() / 2, 0, Rotate.Z_AXIS),
            larmOuter, larmInside
    );
    public final SkinGroup rarm = new SkinGroup(
            new Rotate(0, 0, -rarmInside.getHeight() / 2, 0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, -rarmInside.getWidth() / 2, -rarmInside.getHeight() / 2, 0, Rotate.Z_AXIS),
            rarmOuter, rarmInside
    );
    public final SkinGroup lleg = new SkinGroup(
            new Rotate(0, 0, -llegInside.getHeight() / 2, 0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, 0, -llegInside.getHeight() / 2, 0, Rotate.Z_AXIS),
            llegOuter, llegInside
    );
    public final SkinGroup rleg = new SkinGroup(
            new Rotate(0, 0, -rlegInside.getHeight() / 2, 0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, 0, -rlegInside.getHeight() / 2, 0, Rotate.Z_AXIS),
            rlegOuter, rlegInside
    );

    public final SkinGroup capeGroup = new SkinGroup(
            new Rotate(0, 0, -capeCube.getHeight() / 2, 0, Rotate.X_AXIS),
            new Rotate(0, Rotate.Y_AXIS),
            new Rotate(0, Rotate.Z_AXIS),
            capeCube
    );

    /// 背饰渲染模式：披风（平板）或鞘翅（两片翅膀）
    public enum CapeMode {
        CAPE, ELYTRA
    }

    protected CapeMode capeMode = CapeMode.CAPE;
    protected boolean hasCape;

    /// 鞘翅模型，贴图与披风同源（64×32），由调用方决定传披风图还是独立鞘翅图
    public final ElytraModel elytra = new ElytraModel();
    public final Group elytraGroup = new Group(elytra);

    /// 待机微摆：披风与鞘翅一起做极小幅度的呼吸式摆动，避免看起来像静止的模型
    private boolean swayEnabled;
    private double swayPhase;
    private long swayLastNanos;
    private final javafx.animation.AnimationTimer swayTimer = new javafx.animation.AnimationTimer() {
        @Override
        public void handle(long now) {
            if (swayLastNanos == 0) {
                swayLastNanos = now;
                return;
            }
            // 用真实时间推进相位，掉帧时摆动速度也不会变
            double elapsed = (now - swayLastNanos) / 1_000_000_000.0;
            swayLastNanos = now;
            swayPhase += elapsed * 1.15;

            elytra.setSway(swayPhase);
            // 外层已经固定了 10° 后倾，这里只叠加摆动分量，否则会变成 20°
            capeGroup.getXRotate().setAngle(Math.sin(swayPhase * 0.85) * 1.1);
        }
    };

    protected PerspectiveCamera camera = new PerspectiveCamera(true);

    protected Rotate xRotate = new Rotate(0, Rotate.X_AXIS);
    protected Rotate yRotate = new Rotate(180, Rotate.Y_AXIS);
    protected Rotate zRotate = new Rotate(0, Rotate.Z_AXIS);
    protected Translate translate = new Translate(0, 0, -80);
    protected Scale scale = new Scale(1, 1);

    protected SkinAnimationPlayer animationPlayer = new SkinAnimationPlayer();

    public SkinAnimationPlayer getAnimationPlayer() {
        return animationPlayer;
    }

    public Image getSrcSkin() {
        return srcSkin;
    }

    public Image getSkin() {
        return skin;
    }

    public void updateSkin(Image skin, boolean isSlim, final @Nullable Image cape) {
        updateSkin(skin, isSlim, cape, cape);
    }

    /// 带独立鞘翅贴图的版本。玩家披风文件里如果带了鞘翅图（CSL / 皮肤站），传进来单独渲染；
    /// 否则调用方传 `null` 或直接复用披风图。
    public void updateSkin(Image skin, boolean isSlim, final @Nullable Image cape, final @Nullable Image elytraTexture) {
        if (SkinHelper.isNoRequest(skin) && SkinHelper.isSkin(skin)) {
            this.srcSkin = skin;
            this.skin = SkinHelper.x32Tox64(skin);
            this.srcCape = cape;
            this.cape = cape == null ? null : cape.getWidth() < 256 ? SkinHelper.enlarge(cape, 4, 8) : cape;
            int multiple = Math.max((int) (1024 / skin.getWidth()), 1);
            if (multiple > 1)
                this.skin = SkinHelper.enlarge(this.skin, multiple, multiple);
            updateSkinModel(isSlim, cape != null);
            bindMaterial(root);
            // 鞘翅贴图依次回退：独立鞘翅图 → 披风自带的鞘翅图案 → 官方 elytra.png。
            // 关键在于第三档：没有鞘翅图案的披风绝不能把披风图案铺到翅膀上——
            // 翼形是靠贴图 alpha 裁出来的，一块满绘的披风图只会渲染成一块板砖。
            boolean dedicatedElytra = elytraTexture != null && elytraTexture != cape;
            Image wingTexture;
            if (dedicatedElytra) {
                wingTexture = elytraTexture;
            } else if (ElytraModel.hasElytraArt(cape)) {
                wingTexture = cape;
            } else {
                wingTexture = ElytraModel.getDefaultElytraImage();
            }
            if (wingTexture != null) {
                elytra.setTexture(wingTexture);
            }
        }
    }

    protected void updateSkinModel(boolean isSlim, boolean hasCape) {
        this.isSlim = isSlim;
        FunctionHelper.alwaysB(SkinMultipleCubes::setWidth, isSlim ? 3 : 4, larmOuter, rarmOuter);
        FunctionHelper.alwaysB(SkinCube::setWidth, isSlim ? 3D : 4D, larmInside, rarmInside);

        FunctionHelper.alwaysB(Node::setTranslateX, -(bodyInside.getWidth() + larmInside.getWidth()) / 2, larm);
        FunctionHelper.alwaysB(Node::setTranslateX, +(bodyInside.getWidth() + rarmInside.getWidth()) / 2, rarm);
        if (isSlim) {
            larmInside.setModel(ALEX_LARM.getModel());
            rarmInside.setModel(ALEX_RARM.getModel());
        } else {
            larmInside.setModel(STEVEN_LARM.getModel());
            rarmInside.setModel(STEVEN_RARM.getModel());
        }

        larm.getZRotate().setPivotX(-larmInside.getWidth() / 2);
        rarm.getZRotate().setPivotX(+rarmInside.getWidth() / 2);

        this.hasCape = hasCape;
        applyCapeModeVisibility();
    }

    /// 设置水平观察角度（度）。180 是正面，绕到 0 / 360 附近可以看到背后的披风或鞘翅。
    public void setYaw(double degree) {
        yRotate.setAngle(degree);
    }

    /// 切换背饰形态：披风 / 鞘翅
    public void setCapeMode(@Nullable CapeMode mode) {
        this.capeMode = mode == null ? CapeMode.CAPE : mode;
        applyCapeModeVisibility();
    }

    /// 启动/停止待机微摆。预览页打开时开着，关掉页面时停掉，避免后台空转。
    public void setSwayEnabled(boolean enabled) {
        if (enabled == swayEnabled) {
            return;
        }
        swayEnabled = enabled;
        if (enabled) {
            swayTimer.start();
        } else {
            swayTimer.stop();
        }
    }

    public CapeMode getCapeMode() {
        return capeMode;
    }

    private void applyCapeModeVisibility() {
        capeGroup.setVisible(hasCape && capeMode == CapeMode.CAPE);
        elytra.setVisible(hasCape && capeMode == CapeMode.ELYTRA);
    }

    public SkinCanvas(Image skin, double preW, double preH, boolean msaa) {
        this.skin = skin;
        this.preW = preW;
        this.preH = preH;
        this.msaa = msaa;

        init();
    }

    /// 材质保持 HMCL 原本的写法：只挂 diffuseMap，不加高光调整。
    /// 皮肤、披风、鞘翅三者共用同一个创建入口，外观才会一致。
    protected Material createMaterial(final Image image) {
        PhongMaterial material = new PhongMaterial();
        material.setDiffuseMap(image);
        return material;
    }

    protected void bindMaterial(Group group) {
        Material material = createMaterial(skin);
        for (Node node : group.getChildren())
            if (node instanceof Shape3D)
                ((Shape3D) node).setMaterial(node == capeCube ? createMaterial(cape) : material);
            else if (node instanceof SkinMultipleCubes)
                ((SkinMultipleCubes) node).updateSkin(skin);
            else if (node instanceof Group)
                // 鞘翅用自己的贴图，不能被皮肤的材质覆盖
                if (node != elytraGroup)
                    bindMaterial((Group) node);
    }

    protected Group createPlayerModel() {
        head.setTranslateY(-(bodyInside.getHeight() + headInside.getHeight()) / 2);

        larm.setTranslateX(-(bodyInside.getWidth() + larmInside.getWidth()) / 2);
        rarm.setTranslateX(+(bodyInside.getWidth() + rarmInside.getWidth()) / 2);

        lleg.setTranslateX(-(bodyInside.getWidth() - llegInside.getWidth()) / 2);
        rleg.setTranslateX(+(bodyInside.getWidth() - rlegInside.getWidth()) / 2);

        lleg.setTranslateY(+(bodyInside.getHeight() + llegInside.getHeight()) / 2);
        rleg.setTranslateY(+(bodyInside.getHeight() + rlegInside.getHeight()) / 2);

        capeGroup.setTranslateY(+(capeCube.getHeight() - bodyOuter.getHeight()) / 2);
        // 原版披风紧贴背外侧：身体背面在 z=2、披风占 2..3，中间没有缝。
        // 这里原来用的是 -(身体厚+外层厚)/2 = -4，等于把披风悬空到身后 1.4 格，看着像浮在空中。
        capeGroup.setTranslateZ(-(bodyOuter.getDepth() / 2 + capeCube.getDepth() / 2));

        // 原版站立姿态的披风前倾 6°（PlayerCapeModel 里是 6.0 + 移动量），不是 10°
        capeGroup.getTransforms().addAll(new Rotate(180, Rotate.Y_AXIS), new Rotate(6, Rotate.X_AXIS));

        // 鞘翅挂点按原版 ElytraModel 摆：模型根在身体原点，翼根就在肩线（MC 的 y=0）。
        // 原版 PartPose 只有 offset(5,0,0) 和 ±15° 的 z/x 旋转，这里是组级挂点，
        // 所以 Y 顶到身体上沿，Z 保持在身体中线（左右翼的厚度自己会占到背外侧）。
        elytraGroup.setTranslateY(-bodyOuter.getHeight() / 2);
        // z 保持 0：原版鞘翅方块的 z 是 -1..3（身体 -2..2），外表面只比背多出 1 格。
        // 之前放在 -4（跟着旧披风走）会让翅膀整个悬到身后，看着像飘在空中。
        elytraGroup.setTranslateZ(0);
        // 只做朝向翻转：原版模型是面朝 -z、背朝 +z，这里正好反过来
        elytraGroup.getTransforms().add(new Rotate(180, Rotate.Y_AXIS));

        root.getTransforms().addAll(xRotate);

        root.getChildren().addAll(
                head,
                body,
                larm,
                rarm,
                lleg,
                rleg,
                capeGroup,
                elytraGroup
        );
        updateSkin(skin, false, null);

        return root;
    }

    protected SubScene createSubScene() {
        Group group = new Group();

        // 沿用 HMCL 原本的光照：一盏满亮度环境光。皮肤和披风一直就是这么渲染的，
        // 自己再加方向光会让左右脸一明一暗，反而和启动器别处的预览对不上。
        AmbientLight light = new AmbientLight(Color.WHITE);
        group.getChildren().add(light);

        group.getChildren().add(createPlayerModel());
        group.getTransforms().add(zRotate);

        camera.getTransforms().addAll(yRotate, translate, scale);

        subScene = new SubScene(group, preW, preH, true,
                msaa ? SceneAntialiasing.BALANCED : SceneAntialiasing.DISABLED);
        subScene.setCamera(camera);

        return subScene;
    }

    protected void init() {
        getChildren().add(createSubScene());
    }

    private double lastX, lastY;

    public void enableRotation(double sensitivity) {
        addEventHandler(MouseEvent.MOUSE_PRESSED, e -> {
            lastX = -1;
            lastY = -1;
        });
        addEventHandler(MouseEvent.MOUSE_DRAGGED, e -> {
            if (!(lastX == -1 || lastY == -1)) {
                if (e.isAltDown() || e.isControlDown() || e.isShiftDown()) {
                    if (e.isShiftDown())
                        zRotate.setAngle(zRotate.getAngle() - (e.getSceneY() - lastY) * sensitivity);
                    if (e.isAltDown())
                        yRotate.setAngle(yRotate.getAngle() + (e.getSceneX() - lastX) * sensitivity);
                    if (e.isControlDown())
                        xRotate.setAngle(xRotate.getAngle() + (e.getSceneY() - lastY) * sensitivity);
                } else {
                    double yaw = yRotate.getAngle() + (e.getSceneX() - lastX) * sensitivity;
                    yaw %= 360;
                    if (yaw < 0)
                        yaw += 360;

                    int flagX = yaw < 90 || yaw > 270 ? 1 : -1;
                    int flagZ = yaw < 180 ? -1 : 1;
                    double kx = Math.abs(90 - yaw % 180) / 90 * flagX, kz = Math.abs(90 - (yaw + 90) % 180) / 90 * flagZ;

                    xRotate.setAngle(xRotate.getAngle() + (e.getSceneY() - lastY) * sensitivity * kx);
                    yRotate.setAngle(yaw);
                    zRotate.setAngle(zRotate.getAngle() + (e.getSceneY() - lastY) * sensitivity * kz);
                }
            }
            lastX = e.getSceneX();
            lastY = e.getSceneY();
        });
        addEventHandler(ScrollEvent.SCROLL, e -> {
            double delta = (e.getDeltaY() > 0 ? 1 : e.getDeltaY() == 0 ? 0 : -1) / 10D * sensitivity;
            scale.setX(Math.min(Math.max(scale.getX() - delta, 0.1), 10));
            scale.setY(Math.min(Math.max(scale.getY() - delta, 0.1), 10));
        });
    }

}
