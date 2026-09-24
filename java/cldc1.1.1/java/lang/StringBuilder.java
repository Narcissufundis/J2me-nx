/**
 * java/lang/StringBuilder — j2me-nx-port 类库补全。
 *
 * PluotSorbet 的 CLDC 1.1 类库无此类（无 CharSequence/AbstractStringBuilder），
 * 但大量改版游戏由 javac 5+ 编译，字节码字符串拼接直接引用 StringBuilder。
 *
 * 自写实现（extends Object，不实现 CharSequence——CLDC 1.1 无该接口）：
 * toString 走标准 String(char[], int, int)，不依赖 VM 特殊构造器。
 * 线程安全不保证（与 Java 5+ StringBuilder 语义一致）。
 */

package java.lang;

public final class StringBuilder {

    private char[] value;
    private int count;
    private boolean shared;

    public StringBuilder() {
        value = new char[16];
        count = 0;
    }

    public StringBuilder(int capacity) {
        value = new char[capacity > 0 ? capacity : 16];
        count = 0;
    }

    public StringBuilder(String str) {
        int len = str.length();
        value = new char[len + 16];
        str.getChars(0, len, value, 0);
        count = len;
    }

    public int length() {
        return count;
    }

    public int capacity() {
        return value.length;
    }

    public void ensureCapacity(int minimumCapacity) {
        if (minimumCapacity > value.length) {
            int newCap = value.length * 2 + 2;
            if (newCap < minimumCapacity) {
                newCap = minimumCapacity;
            }
            expandCapacity(newCap);
        }
    }

    private void expandCapacity(int newCap) {
        char[] newValue = new char[newCap];
        System.arraycopy(value, 0, newValue, 0, count);
        value = newValue;
    }

    public void trimToSize() {
        if (count < value.length) {
            char[] newValue = new char[count];
            System.arraycopy(value, 0, newValue, 0, count);
            value = newValue;
        }
    }

    private void copyWhenShared() {
        if (shared) {
            char[] newValue = new char[value.length];
            System.arraycopy(value, 0, newValue, 0, count);
            value = newValue;
            shared = false;
        }
    }

    public char charAt(int index) {
        if (index < 0 || index >= count) {
            throw new StringIndexOutOfBoundsException(index);
        }
        return value[index];
    }

    public void setCharAt(int index, char ch) {
        if (index < 0 || index >= count) {
            throw new StringIndexOutOfBoundsException(index);
        }
        copyWhenShared();
        value[index] = ch;
    }

    public StringBuilder append(Object obj) {
        return append(String.valueOf(obj));
    }

    public StringBuilder append(String str) {
        if (str == null) {
            str = "null";
        }
        int len = str.length();
        ensureCapacity(count + len);
        copyWhenShared();
        str.getChars(0, len, value, count);
        count += len;
        return this;
    }

    public StringBuilder append(StringBuffer sb) {
        if (sb == null) {
            return append("null");
        }
        return append(sb.toString());
    }

    public StringBuilder append(char[] str) {
        if (str == null) {
            return append("null");
        }
        return append(str, 0, str.length);
    }

    public StringBuilder append(char[] str, int offset, int len) {
        if (str == null) {
            str = "null".toCharArray();
        }
        if (offset < 0 || len < 0 || offset + len > str.length) {
            throw new StringIndexOutOfBoundsException();
        }
        ensureCapacity(count + len);
        copyWhenShared();
        System.arraycopy(str, offset, value, count, len);
        count += len;
        return this;
    }

    public StringBuilder append(boolean b) {
        return append(b ? "true" : "false");
    }

    public StringBuilder append(char c) {
        ensureCapacity(count + 1);
        copyWhenShared();
        value[count++] = c;
        return this;
    }

    public StringBuilder append(int i) {
        return append(String.valueOf(i));
    }

    public StringBuilder append(long l) {
        return append(String.valueOf(l));
    }

    public StringBuilder append(float f) {
        return append(String.valueOf(f));
    }

    public StringBuilder append(double d) {
        return append(String.valueOf(d));
    }

    public StringBuilder delete(int start, int end) {
        if (start < 0) {
            throw new StringIndexOutOfBoundsException(start);
        }
        if (end > count) {
            end = count;
        }
        if (start > end) {
            throw new StringIndexOutOfBoundsException();
        }
        int len = end - start;
        if (len > 0) {
            copyWhenShared();
            System.arraycopy(value, start + len, value, start, count - end);
            count -= len;
        }
        return this;
    }

    public StringBuilder deleteCharAt(int index) {
        if (index < 0 || index >= count) {
            throw new StringIndexOutOfBoundsException(index);
        }
        copyWhenShared();
        System.arraycopy(value, index + 1, value, index, count - index - 1);
        count--;
        return this;
    }

    public StringBuilder replace(int start, int end, String str) {
        if (start < 0) {
            throw new StringIndexOutOfBoundsException(start);
        }
        if (end > count) {
            end = count;
        }
        if (start > end) {
            throw new StringIndexOutOfBoundsException();
        }
        int len = str.length();
        int newCount = count + len - (end - start);
        ensureCapacity(newCount);
        copyWhenShared();
        System.arraycopy(value, end, value, start + len, count - end);
        str.getChars(0, len, value, start);
        count = newCount;
        return this;
    }

    public StringBuilder insert(int offset, String str) {
        if (offset < 0 || offset > count) {
            throw new StringIndexOutOfBoundsException(offset);
        }
        if (str == null) {
            str = "null";
        }
        int len = str.length();
        ensureCapacity(count + len);
        copyWhenShared();
        System.arraycopy(value, offset, value, offset + len, count - offset);
        str.getChars(0, len, value, offset);
        count += len;
        return this;
    }

    public StringBuilder insert(int offset, char c) {
        return insert(offset, String.valueOf(c));
    }

    public StringBuilder insert(int offset, boolean b) {
        return insert(offset, String.valueOf(b));
    }

    public StringBuilder insert(int offset, int i) {
        return insert(offset, String.valueOf(i));
    }

    public StringBuilder insert(int offset, long l) {
        return insert(offset, String.valueOf(l));
    }

    public StringBuilder insert(int offset, float f) {
        return insert(offset, String.valueOf(f));
    }

    public StringBuilder insert(int offset, double d) {
        return insert(offset, String.valueOf(d));
    }

    public StringBuilder insert(int offset, char[] str) {
        if (offset < 0 || offset > count) {
            throw new StringIndexOutOfBoundsException(offset);
        }
        int len = (str == null) ? 4 : str.length;
        ensureCapacity(count + len);
        copyWhenShared();
        System.arraycopy(value, offset, value, offset + len, count - offset);
        if (str == null) {
            "null".getChars(0, 4, value, offset);
        } else {
            System.arraycopy(str, 0, value, offset, str.length);
        }
        count += len;
        return this;
    }

    public StringBuilder reverse() {
        copyWhenShared();
        int n = count - 1;
        for (int j = (n - 1) >> 1; j >= 0; j--) {
            char temp = value[j];
            value[j] = value[n - j];
            value[n - j] = temp;
        }
        return this;
    }

    public String toString() {
        return new String(value, 0, count);
    }
}
