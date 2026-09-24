/*
 * LayerManager — JSR-118 Game API 补全
 * 上游 PluotSorbet 移植 lcdui.game 包时遗漏此类（Layer/Sprite/TiledLayer/
 * GameCanvas/GameAccessImpl 已有），大量游戏依赖 LayerManager 管理图层。
 * 按 JSR-118 语义实现：index 0 最先绘制（最底层），append 追加到顶层；
 * 视窗默认 (0,0,100,100)。
 *
 * 实现约束：只用 Graphics.translate/setClip/getClip* —— 不用 clipRect
 * （PluotSorbet 的 JS 侧 Graphics 未必实现了对应 native，宁少勿缺）。
 */

package javax.microedition.lcdui.game;

import javax.microedition.lcdui.Graphics;
import java.util.Vector;

public class LayerManager extends Layer {

    /** 图层列表。index 0 = 最先绘制（最底层），末尾 = 最顶层。 */
    private Vector layers = new Vector(4, 4);

    /** 视窗（view window），paint(g,x,y) 时映射到画布 (x,y)。 */
    private int windowX = 0;
    private int windowY = 0;
    private int windowWidth = 100;
    private int windowHeight = 100;

    /**
     * Creates a new LayerManager. The view window is initially
     * positioned at (0,0) and sized to 100x100 pixels.
     */
    public LayerManager() {
        super(0, 0);
    }

    /**
     * Appends a Layer to this LayerManager. The Layer is appended to
     * the list of existing Layers (drawn last, i.e. on top).
     *
     * @param layer the Layer to append
     * @throws NullPointerException if layer is null
     */
    public void append(Layer layer) {
        if (layer == null) {
            throw new NullPointerException();
        }
        remove(layer);
        layers.addElement(layer);
    }

    /**
     * Inserts a Layer at the given index. Layers above the insert
     * position shift up by one.
     *
     * @param layer the Layer to insert
     * @param index the index at which to insert
     * @throws NullPointerException if layer is null
     * @throws IndexOutOfBoundsException if index is out of range
     */
    public void insert(Layer layer, int index) {
        if (layer == null) {
            throw new NullPointerException();
        }
        if (index < 0 || index > layers.size()) {
            throw new IndexOutOfBoundsException();
        }
        remove(layer);
        layers.insertElementAt(layer, index);
    }

    /**
     * Gets the Layer at the given index.
     *
     * @param index the index of the Layer
     * @return the Layer at that index
     * @throws IndexOutOfBoundsException if index is out of range
     */
    public Layer getLayerAt(int index) {
        if (index < 0 || index >= layers.size()) {
            throw new IndexOutOfBoundsException();
        }
        return (Layer) layers.elementAt(index);
    }

    /**
     * Gets the number of Layers in this LayerManager.
     *
     * @return the number of Layers
     */
    public int getSize() {
        return layers.size();
    }

    /**
     * Removes the given Layer from this LayerManager. Does nothing if
     * the Layer is not in the list.
     *
     * @param layer the Layer to remove
     */
    public void remove(Layer layer) {
        if (layer == null) {
            throw new NullPointerException();
        }
        layers.removeElement(layer);
    }

    /**
     * Removes all Layers from this LayerManager.
     */
    public void removeAll() {
        layers.removeAllElements();
    }

    /**
     * Sets the view window. The view window specifies the region of the
     * composed layers that is drawn by paint(g, x, y).
     *
     * @param x the horizontal origin of the view window
     * @param y the vertical origin of the view window
     * @param width the width of the view window
     * @param height the height of the view window
     * @throws IllegalArgumentException if width or height is negative
     */
    public void setViewWindow(int x, int y, int width, int height) {
        if (width < 0 || height < 0) {
            throw new IllegalArgumentException();
        }
        windowX = x;
        windowY = y;
        windowWidth = width;
        windowHeight = height;
    }

    /**
     * Renders the composed layers at (x, y) on the given Graphics,
     * clipped to the view window. Layers are painted in index order
     * (index 0 first, i.e. bottom-most).
     *
     * @param g the Graphics to draw on
     * @param x the horizontal position of the view window's origin
     * @param y the vertical position of the view window's origin
     * @throws NullPointerException if g is null
     */
    public final void paint(Graphics g, int x, int y) {
        if (g == null) {
            throw new NullPointerException();
        }
        // 当前裁剪为空则无事可做
        if (g.getClipWidth() <= 0 || g.getClipHeight() <= 0) {
            return;
        }

        // 保存现场（restore 用；不用 getTranslate 系，减少对未实现方法的依赖）
        int savedClipX = g.getClipX();
        int savedClipY = g.getClipY();
        int savedClipW = g.getClipWidth();
        int savedClipH = g.getClipHeight();

        int dx = x - windowX;
        int dy = y - windowY;
        g.translate(dx, dy);

        // 新坐标系下的当前裁剪矩形 = 原裁剪平移 (-dx,-dy)
        int cx = savedClipX - dx;
        int cy = savedClipY - dy;

        // 与视窗矩形求交（新坐标系）
        int ix1 = cx > windowX ? cx : windowX;
        int iy1 = cy > windowY ? cy : windowY;
        int ix2 = (cx + savedClipW) < (windowX + windowWidth)
                ? (cx + savedClipW) : (windowX + windowWidth);
        int iy2 = (cy + savedClipH) < (windowY + windowHeight)
                ? (cy + savedClipH) : (windowY + windowHeight);

        if (ix2 > ix1 && iy2 > iy1) {
            g.setClip(ix1, iy1, ix2 - ix1, iy2 - iy1);
            for (int i = 0; i < layers.size(); i++) {
                Layer layer = (Layer) layers.elementAt(i);
                if (layer.visible) {
                    layer.paint(g);
                }
            }
        }

        // 恢复现场
        g.translate(-dx, -dy);
        g.setClip(savedClipX, savedClipY, savedClipW, savedClipH);
    }

    /**
     * Layer 的抽象 paint 实现。LayerManager 不直接支持单参 paint——
     * JSR-118 要求通过 paint(g, x, y) 指定视窗原点。空实现。
     *
     * @param g the Graphics (ignored)
     */
    public final void paint(Graphics g) {
        // no-op
    }
}
