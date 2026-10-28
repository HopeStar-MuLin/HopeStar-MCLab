/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026  huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
package org.jackhuang.hmcl.ui.account.wardrobe;

import com.jfoenix.controls.JFXButton;
import com.jfoenix.controls.JFXDialogLayout;
import javafx.application.Platform;
import javafx.beans.property.*;
import javafx.beans.value.ObservableValue;
import javafx.collections.ListChangeListener;
import javafx.css.PseudoClass;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.control.Label;
import javafx.scene.control.OverrunStyle;
import javafx.scene.control.ScrollPane;
import javafx.scene.control.Separator;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import javafx.scene.input.TransferMode;
import javafx.scene.layout.*;
import javafx.stage.FileChooser;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount;
import org.jackhuang.hmcl.auth.microsoft.MicrosoftService;
import org.jackhuang.hmcl.auth.yggdrasil.TextureModel;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.SVG;
import org.jackhuang.hmcl.ui.construct.DialogCloseEvent;
import org.jackhuang.hmcl.ui.construct.MessageDialogPane.MessageType;
import org.jackhuang.hmcl.ui.construct.SpinnerPane;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;
import org.jackhuang.hmcl.ui.skin.animation.SkinAniRunning;
import org.jackhuang.hmcl.ui.skin.animation.SkinAniWavingArms;
import org.jackhuang.hmcl.util.io.FileUtils;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static org.jackhuang.hmcl.ui.FXUtils.onEscPressed;
import static org.jackhuang.hmcl.util.i18n.I18n.i18n;
import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/**
 * 衣柜：皮肤本地库 + 3D 实时预览 + 披风切换。
 *
 * <p>数据流：
 * <ul>
 *   <li>皮肤：选中本地库（{@link SkinLibrary}）里的条目只改预览，点"应用"才上传到官方服务器。</li>
 *   <li>披风：正版账号从 {@code GET /minecraft/profile} 拉取拥有列表；选中只改预览，
 *       点"应用"走 {@code PUT /minecraft/profile/capes/active} 或 {@code DELETE}（不显示披风）。</li>
 *   <li>渲染：完全复用 {@link SkinCanvas}，换皮肤/换披风都只是重调
 *       {@link SkinCanvas#updateSkin(Image, boolean, Image)}。</li>
 * </ul>
 */
public final class WardrobePane extends StackPane {

    /// 哨兵值：表示"不显示披风"
    private static final String NO_CAPE = "";

    private static final PseudoClass SELECTED = PseudoClass.getPseudoClass("selected");

    private record CapeItem(String id, String alias, String url, boolean active) {
    }

    private final Account account;
    private final SkinLibrary library = SkinLibrary.getInstance();

    private final SkinCanvas canvas;

    private final TilePane skinGrid = new TilePane();
    private final FlowPane capeGrid = new FlowPane();
    private final Label skinStatus = new Label();
    private final Label capeStatus = new Label();
    private final Label libraryHint = new Label(i18n("account.skin.wardrobe.empty"));

    private final JFXButton applyButton = new JFXButton();
    private final SpinnerPane applySpinner = new SpinnerPane();

    private final ObjectProperty<SkinLibrary.Entry> selectedEntry = new SimpleObjectProperty<>();
    private final StringProperty selectedCapeId = new SimpleStringProperty(NO_CAPE);
    private final ObjectProperty<Image> previewCapeImage = new SimpleObjectProperty<>();

    /// 账号当前的皮肤/模型，用作"没有选中库里皮肤"时的预览底图
    private final ObjectProperty<Image> accountSkinImage = new SimpleObjectProperty<>();
    private final BooleanProperty accountSkinSlim = new SimpleBooleanProperty(false);

    private final Map<String, Node> skinTiles = new LinkedHashMap<>();
    private final Map<String, Node> capeTiles = new LinkedHashMap<>();
    private final List<CapeItem> capes = new ArrayList<>();

    private String originalCapeId = NO_CAPE;
    private boolean capeSupported;

    public WardrobePane(Account account) {
        this.account = Objects.requireNonNull(account);

        getStyleClass().add("wardrobe-pane");

        JFXDialogLayout layout = new JFXDialogLayout();
        getChildren().setAll(layout);
        layout.setHeading(new Label(i18n("account.skin.wardrobe")));

        canvas = new SkinCanvas(TexturesLoader.getDefaultSkinImage(), 300, 320, true);
        canvas.enableRotation(.5);
        canvas.getAnimationPlayer().addSkinAnimation(
                new SkinAniWavingArms(100, 2000, 7.5, canvas),
                new SkinAniRunning(100, 100, 30, canvas));

        // ==== 左侧：3D 预览 ====
        StackPane canvasPane = new StackPane(canvas);
        canvasPane.setPrefSize(300, 320);
        canvasPane.setMinSize(300, 320);
        canvasPane.getStyleClass().add("wardrobe-preview");

        // 拖 PNG 进来 = 导入皮肤库
        canvasPane.setOnDragOver(e -> {
            if (e.getDragboard().hasFiles() && isPng(e.getDragboard().getFiles().get(0).toPath())) {
                e.acceptTransferModes(TransferMode.COPY);
            }
        });
        canvasPane.setOnDragDropped(e -> {
            if (e.isAccepted()) {
                importSkin(e.getDragboard().getFiles().get(0).toPath());
            }
        });

        VBox statusBox = new VBox(2, skinStatus, capeStatus);
        statusBox.setPadding(new Insets(8, 0, 0, 0));

        VBox previewBox = new VBox(8, canvasPane, statusBox);
        previewBox.setPrefWidth(300);
        previewBox.setMinWidth(300);

        // ==== 右侧：披风 + 皮肤库 ====
        capeGrid.setHgap(8);
        capeGrid.setVgap(8);
        capeGrid.setPrefWrapLength(360);
        capeGrid.setPadding(new Insets(4, 0, 0, 0));

        VBox capeSection = new VBox(6, sectionTitle(i18n("account.cape")), capeGrid);

        skinGrid.setHgap(8);
        skinGrid.setVgap(8);
        skinGrid.setPrefColumns(4);
        skinGrid.setPrefTileWidth(88);
        skinGrid.setPrefTileHeight(96);

        ScrollPane skinScroll = new ScrollPane(skinGrid);
        skinScroll.setFitToWidth(true);
        skinScroll.setHbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);
        skinScroll.setPrefHeight(260);
        VBox.setVgrow(skinScroll, Priority.ALWAYS);

        JFXButton importButton = new JFXButton(i18n("account.skin.wardrobe.import"));
        importButton.setGraphic(SVG.ADD.createIcon(16));
        importButton.getStyleClass().add("jfx-button-raised");
        importButton.setOnAction(e -> chooseSkinFile());

        HBox skinHeader = new HBox(8, sectionTitle(i18n("account.skin")), spacer(), importButton);
        skinHeader.setAlignment(Pos.CENTER_LEFT);

        VBox rightBox = new VBox(10, capeSection, new Separator(), skinHeader, libraryHint, skinScroll);
        rightBox.setPrefWidth(380);
        rightBox.setMinWidth(340);
        HBox.setHgrow(rightBox, Priority.ALWAYS);

        HBox body = new HBox(20, previewBox, rightBox);
        body.setPadding(new Insets(4, 0, 0, 0));
        layout.setBody(body);

        // ==== 底部按钮 ====
        applyButton.setText(i18n("account.skin.wardrobe.apply"));
        applyButton.setGraphic(SVG.CHECKROOM.createIcon(16));
        applyButton.getStyleClass().add("dialog-accept");
        applyButton.setOnAction(e -> apply());

        applySpinner.setContent(applyButton);
        applySpinner.getStyleClass().add("small-spinner-pane");

        JFXButton deleteButton = new JFXButton(i18n("button.remove"));
        deleteButton.setGraphic(SVG.DELETE_FOREVER.createIcon(16));
        deleteButton.getStyleClass().add("dialog-cancel");
        deleteButton.setOnAction(e -> {
            SkinLibrary.Entry entry = selectedEntry.get();
            if (entry == null) {
                return;
            }
            Controllers.confirm(i18n("button.remove.confirm"), i18n("button.remove"), () -> {
                library.remove(entry);
                selectedEntry.set(null);
            }, null);
        });

        JFXButton closeButton = new JFXButton(i18n("button.close"));
        closeButton.getStyleClass().add("dialog-cancel");
        closeButton.setOnAction(e -> fireEvent(new DialogCloseEvent()));
        onEscPressed(this, closeButton::fire);

        layout.setActions(deleteButton, spacer(), applySpinner, closeButton);

        // ==== 初始化 ====
        selectedEntry.addListener((a, b, c) -> {
            updateSkinSelection();
            refreshPreview();
        });
        selectedCapeId.addListener((a, b, c) -> {
            updateCapeSelection();
            selectCapePreview(c);
            updateApplyState();
        });
        previewCapeImage.addListener((a, b, c) -> refreshPreview());
        accountSkinImage.addListener((a, b, c) -> refreshPreview());
        accountSkinSlim.addListener((a, b, c) -> refreshPreview());

        library.getEntries().addListener((ListChangeListener<SkinLibrary.Entry>) change -> buildSkinGrid());

        bindAccountTextures();
        buildSkinGrid();
        loadCapes();
        refreshPreview();
    }

    // ==== 账号当前纹理 ====

    private void bindAccountTextures() {
        ObservableValue<TexturesLoader.LoadedTexture> binding = TexturesLoader.skinBinding(account);
        binding.addListener((a, oldTexture, newTexture) -> applyAccountSkin(newTexture));

        if (binding.getValue() != null) {
            applyAccountSkin(binding.getValue());
        }
    }

    private void applyAccountSkin(TexturesLoader.LoadedTexture texture) {
        if (texture == null) {
            return;
        }
        accountSkinImage.set(texture.image());
        accountSkinSlim.set(TextureModel.SLIM.modelName.equals(texture.metadata().get("model")));
    }

    // ==== 披风 ====

    private void loadCapes() {
        if (!(account instanceof MicrosoftAccount microsoftAccount)) {
            capeSupported = false;
            capeGrid.getChildren().setAll(hint(i18n("account.skin.wardrobe.cape_unsupported")));
            capeStatus.setText(i18n("account.skin.wardrobe.cape_unsupported"));
            updateApplyState();
            return;
        }

        capeSupported = true;
        capeGrid.getChildren().setAll(hint(i18n("message.loading")));

        Task.runAsync(() -> {
            List<MicrosoftService.MinecraftProfileResponseCape> list = microsoftAccount.getCapes();
            Platform.runLater(() -> applyCapeList(list));
        }).whenComplete(Schedulers.javafx(), exception -> {
            if (exception != null) {
                LOG.warning("Failed to fetch capes", exception);
                capeGrid.getChildren().setAll(hint(i18n("account.skin.wardrobe.cape_failed")));
                capeStatus.setText(i18n("account.skin.wardrobe.cape_failed"));
            }
        }).start();
    }

    private void applyCapeList(List<MicrosoftService.MinecraftProfileResponseCape> list) {
        capes.clear();
        String activeId = NO_CAPE;

        for (MicrosoftService.MinecraftProfileResponseCape cape : list) {
            if (cape.id == null) {
                continue;
            }
            capes.add(new CapeItem(cape.id,
                    cape.alias != null ? cape.alias : cape.id,
                    cape.url,
                    cape.isActive()));
            if (cape.isActive()) {
                activeId = cape.id;
            }
        }

        originalCapeId = activeId;
        buildCapeGrid();
        selectedCapeId.set(activeId);
        selectCapePreview(activeId);
        updateApplyState();
    }

    private void buildCapeGrid() {
        capeGrid.getChildren().clear();
        capeTiles.clear();

        // "不显示披风" 永远排第一
        Node noneTile = createCapeTile(NO_CAPE, i18n("account.cape.none"), null);
        capeTiles.put(NO_CAPE, noneTile);
        capeGrid.getChildren().add(noneTile);

        for (CapeItem cape : capes) {
            Node tile = createCapeTile(cape.id(), cape.alias(), cape.url());
            capeTiles.put(cape.id(), tile);
            capeGrid.getChildren().add(tile);
        }

        updateCapeSelection();
    }

    private Node createCapeTile(String capeId, String label, String url) {
        ImageView view = new ImageView();
        view.setFitWidth(26);
        view.setFitHeight(44);
        view.setSmooth(false);

        StackPane thumb = new StackPane(view);
        thumb.setPrefSize(32, 48);
        thumb.setMinSize(32, 48);
        thumb.getStyleClass().add("wardrobe-cape-thumb");

        Label caption = new Label(label);
        caption.setMaxWidth(64);
        caption.setTextOverrun(OverrunStyle.ELLIPSIS);

        VBox tile = new VBox(4, thumb, caption);
        tile.setAlignment(Pos.CENTER);
        tile.setPrefWidth(72);
        tile.getStyleClass().add("wardrobe-cape-tile");

        if (url != null) {
            TexturesLoader.loadRemoteTexture(url).thenAccept(image -> Platform.runLater(() -> {
                if (image != null) {
                    view.setImage(capeThumbnail(image));
                }
            }));
        }

        tile.setOnMouseClicked(e -> selectedCapeId.set(capeId));
        return tile;
    }

    private void updateCapeSelection() {
        String selected = selectedCapeId.get();
        capeTiles.forEach((id, node) -> node.pseudoClassStateChanged(SELECTED, id.equals(selected)));
    }

    private void selectCapePreview(String capeId) {
        if (NO_CAPE.equals(capeId)) {
            previewCapeImage.set(null);
            capeStatus.setText(i18n("account.cape.none"));
            return;
        }

        for (CapeItem cape : capes) {
            if (cape.id().equals(capeId)) {
                capeStatus.setText(cape.alias());
                if (cape.url() != null) {
                    TexturesLoader.loadRemoteTexture(cape.url()).thenAccept(image ->
                            Platform.runLater(() -> previewCapeImage.set(image)));
                } else {
                    previewCapeImage.set(null);
                }
                return;
            }
        }
    }

    // ==== 皮肤库 ====

    private void buildSkinGrid() {
        skinGrid.getChildren().clear();
        skinTiles.clear();

        for (SkinLibrary.Entry entry : library.getEntries()) {
            Node tile = createSkinTile(entry);
            skinTiles.put(entry.getId(), tile);
            skinGrid.getChildren().add(tile);
        }

        boolean empty = library.getEntries().isEmpty();
        libraryHint.setVisible(empty);
        libraryHint.setManaged(empty);

        updateSkinSelection();
    }

    private Node createSkinTile(SkinLibrary.Entry entry) {
        ImageView view = new ImageView();
        view.setFitWidth(56);
        view.setFitHeight(56);
        view.setSmooth(false);
        try {
            view.setImage(SkinLibrary.headImage(library.imageOf(entry)));
        } catch (IOException e) {
            LOG.warning("Failed to load skin thumbnail " + entry.getId(), e);
        }

        Label name = new Label(entry.getName());
        name.setMaxWidth(80);
        name.setTextOverrun(OverrunStyle.ELLIPSIS);

        VBox tile = new VBox(6, view, name);
        tile.setAlignment(Pos.CENTER);
        tile.setPrefWidth(84);
        tile.setPrefHeight(92);
        tile.getStyleClass().add("wardrobe-skin-tile");

        tile.setOnMouseClicked(e -> {
            selectedEntry.set(entry);
            if (e.getClickCount() >= 2) {
                apply();
            }
        });

        return tile;
    }

    private void updateSkinSelection() {
        SkinLibrary.Entry selected = selectedEntry.get();
        String selectedId = selected != null ? selected.getId() : null;
        skinTiles.forEach((id, node) -> node.pseudoClassStateChanged(SELECTED, id.equals(selectedId)));
    }

    private void chooseSkinFile() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle(i18n("account.skin.wardrobe.import"));
        chooser.getExtensionFilters().add(new FileChooser.ExtensionFilter(i18n("account.skin.file"), "*.png"));
        Path selected = Controllers.showOpenDialog(chooser);
        if (selected != null) {
            importSkin(selected);
        }
    }

    private void importSkin(Path file) {
        try {
            selectedEntry.set(library.importSkin(file));
        } catch (IOException e) {
            LOG.warning("Failed to import skin " + file, e);
            Controllers.dialog(i18n("account.skin.invalid_skin"), i18n("message.error"), MessageType.ERROR);
        }
    }

    // ==== 预览 ====

    private void refreshPreview() {
        SkinLibrary.Entry entry = selectedEntry.get();

        Image skin = null;
        boolean slim = false;

        if (entry != null) {
            try {
                skin = library.imageOf(entry);
                slim = entry.isSlim();
            } catch (IOException e) {
                LOG.warning("Failed to load preview skin " + entry.getId(), e);
            }
        }

        if (skin == null) {
            skin = accountSkinImage.get();
            slim = accountSkinSlim.get();
        }
        if (skin == null) {
            skin = TexturesLoader.getDefaultSkin(account.getProfileID()).image();
            slim = TexturesLoader.getDefaultModel(account.getProfileID()) == TextureModel.SLIM;
        }

        canvas.updateSkin(skin, slim, previewCapeImage.get());

        skinStatus.setText(i18n("account.skin.wardrobe.skin_status",
                entry != null ? entry.getName() : i18n("account.skin.wardrobe.account_skin"),
                i18n("account.skin.model." + (slim ? TextureModel.SLIM.modelName : TextureModel.WIDE.modelName))));
        capeStatus.setText(describeCape());
        updateApplyState();
    }

    private String describeCape() {
        if (!capeSupported) {
            return i18n("account.skin.wardrobe.cape_unsupported");
        }
        String capeId = selectedCapeId.get();
        if (NO_CAPE.equals(capeId)) {
            return i18n("account.cape.none");
        }
        for (CapeItem cape : capes) {
            if (cape.id().equals(capeId)) {
                return cape.alias();
            }
        }
        return i18n("account.cape.none");
    }

    // ==== 应用 ====

    private void updateApplyState() {
        boolean dirty = selectedEntry.get() != null
                || (capeSupported && !Objects.equals(selectedCapeId.get(), originalCapeId));
        applyButton.setDisable(!dirty);
    }

    private void apply() {
        SkinLibrary.Entry entry = selectedEntry.get();
        boolean capeChanged = capeSupported && !Objects.equals(selectedCapeId.get(), originalCapeId);
        if (entry == null && !capeChanged) {
            return;
        }

        String targetCapeId = selectedCapeId.get();

        Task<Void> task = entry != null
                ? library.apply(account, entry)
                : Task.runAsync(() -> {
        });

        if (capeChanged) {
            task = task.thenRunAsync(() -> {
                if (account instanceof MicrosoftAccount microsoftAccount) {
                    microsoftAccount.setActiveCape(NO_CAPE.equals(targetCapeId) ? null : targetCapeId);
                }
            });
        }

        applySpinner.showSpinner();
        task.whenComplete(Schedulers.javafx(), exception -> {
            applySpinner.hideSpinner();
            if (exception != null) {
                LOG.warning("Failed to apply wardrobe changes", exception);
                Controllers.dialog(Accounts.localizeErrorMessage(exception),
                        i18n("account.skin.upload.failed"), MessageType.ERROR);
            } else {
                originalCapeId = targetCapeId;
                selectedEntry.set(null);
                Controllers.showToast(i18n("message.success"));
                loadCapes();
            }
        }).start();
    }

    // ==== 小工具 ====

    private static Label sectionTitle(String text) {
        Label label = new Label(text);
        label.getStyleClass().add("wardrobe-section-title");
        return label;
    }

    private static Label hint(String text) {
        Label label = new Label(text);
        label.setWrapText(true);
        label.getStyleClass().add("wardrobe-hint");
        return label;
    }

    private static Region spacer() {
        Region region = new Region();
        HBox.setHgrow(region, Priority.ALWAYS);
        return region;
    }

    private static boolean isPng(Path path) {
        return "png".equalsIgnoreCase(FileUtils.getExtension(FileUtils.getName(path)));
    }

    /**
     * 披风纹理是 64x32，可见部分在 (1,1) 起 10x16。缩略图直接裁这块，比整图缩放清楚。
     */
    private static Image capeThumbnail(Image cape) {
        int unit = Math.max(1, (int) cape.getWidth() / 64);
        int width = 10 * unit;
        int height = 16 * unit;

        WritableImage out = new WritableImage(width, height);
        PixelReader reader = cape.getPixelReader();
        if (reader == null) {
            return out;
        }
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int sx = Math.min((int) cape.getWidth() - 1, unit + x);
                int sy = Math.min((int) cape.getHeight() - 1, unit + y);
                out.getPixelWriter().setArgb(x, y, reader.getArgb(sx, sy));
            }
        }
        return out;
    }
}
