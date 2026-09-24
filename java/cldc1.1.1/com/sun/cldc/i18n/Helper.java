/*
 *   
 *
 * Copyright  1990-2007 Sun Microsystems, Inc. All Rights Reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER
 * 
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License version
 * 2 only, as published by the Free Software Foundation.
 * 
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License version 2 for more details (a copy is
 * included at /legal/license.txt).
 * 
 * You should have received a copy of the GNU General Public License
 * version 2 along with this work; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 * 02110-1301 USA
 * 
 * Please contact Sun Microsystems, Inc., 4150 Network Circle, Santa
 * Clara, CA 95054 or visit www.sun.com if you need additional
 * information or have any questions.
 */

package com.sun.cldc.i18n;

import java.io.*;

/**
 * This class provides general helper functions for the J2ME environment.
 * <p>
 * <em>No application code should reference this class directly.</em>
 *
 * @version CLDC 1.1 03/29/02
 */
public class Helper {

    /**
     * The name of the default character encoding
     */
    private static String defaultEncoding;

    /**
     * Default path to the J2ME classes
     */
    private static String defaultMEPath;

    /**
     * Class initializer
     */
    static {
        /* Get the default encoding name */
        defaultEncoding = System.getProperty("microedition.encoding");
        if (defaultEncoding == null) {
            defaultEncoding = "ISO-8859-1";
        }

        /* Set the default system library path */
        defaultMEPath = "com.sun.cldc.i18n.j2me";
    }

/*------------------------------------------------------------------------------*/
/*                               Character encoding                             */
/*------------------------------------------------------------------------------*/

    /**
     * Get a reader for an InputStream
     *
     * @param  is              The input stream the reader is for
     * @return                 A new reader for the stream
     */
    public static Reader getStreamReader(InputStream is) {
        try {
            return getStreamReader(is, defaultEncoding);
        } catch(UnsupportedEncodingException x) {
            try {
                defaultEncoding = "ISO8859_1";
                return getStreamReader(is, defaultEncoding);
            } catch(UnsupportedEncodingException e) {
                throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                           "Missing default encoding "+defaultEncoding
/* #endif */
                );
            }
        }
    }

    /**
     * Get a reader for an InputStream
     *
     * @param  is              The input stream the reader is for
     * @param  name            The name of the decoder
     * @return                 A new reader for the stream
     * @exception UnsupportedEncodingException  If the encoding is not known
     */
    public static Reader getStreamReader(InputStream is, String name)
        throws UnsupportedEncodingException {

        /* Test for null arguments */
        if (is == null || name == null) {
            throw new NullPointerException();
        }

        /* Get the reader from the encoding */
        StreamReader fr = getStreamReaderPrim(name);

        /* Open the connection and return*/
        return fr.open(is, name);
    }

    /**
     * Get a reader for an InputStream
     *
     * @param  is              The input stream the reader is for
     * @param  name            The name of the decoder
     * @return                 A new reader for the stream
     * @exception UnsupportedEncodingException  If the encoding is not known
     */
    private static StreamReader getStreamReaderPrim(String name)
        throws UnsupportedEncodingException {
        try {
            return (StreamReader)getStreamReaderOrWriter(name, "_Reader");
        } catch(ClassCastException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "ClassCastException "+x.getMessage()
/* #endif */
            );
        }
    }

    private static Object getStreamReaderOrWriter(String name, String suffix)
        throws UnsupportedEncodingException {
        if (name == null) {
            throw new NullPointerException();
        }

        name = internalNameForEncoding(name);

        try {
             String className;

             /* Get the reader class name */
             className = defaultMEPath + '.' + name + suffix;

             /* Using the decoder names lookup the implementation class */
             Class clazz = Class.forName(className);

             /* Return a new instance */
             return clazz.newInstance();
        } catch(ClassNotFoundException x) {
            throw new UnsupportedEncodingException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "Encoding "+name+" not found"
/* #endif */
            );
        } catch(InstantiationException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "InstantiationException "+x.getMessage()
/* #endif */
            );
        } catch(IllegalAccessException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "IllegalAccessException "+x.getMessage()
/* #endif */
            );
        }
    }

    /**
     * Get a writer for an OutputStream
     *
     * @param  os              The output stream the reader is for
     * @return                 A new writer for the stream
     */
    public static Writer getStreamWriter(OutputStream os) {
        try {
            return getStreamWriter(os, defaultEncoding);
        } catch(UnsupportedEncodingException x) {
            try {
                defaultEncoding = "ISO8859_1";
                return getStreamWriter(os, defaultEncoding);
            } catch(UnsupportedEncodingException e) {
                throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                           "Missing default encoding " + 
/// skipped                           defaultEncoding
/* #endif */
                );
            }
        }
    }

    /**
     * Get a writer for an OutputStream
     *
     * @param  os              The output stream the reader is for
     * @param  name            The name of the decoder
     * @return                 A new writer for the stream
     * @exception UnsupportedEncodingException  If the encoding is not known
     */
    public static Writer getStreamWriter(OutputStream os, String name)
        throws UnsupportedEncodingException {

        /* Test for null arguments */
        if (os == null || name == null) {
            throw new NullPointerException();
        }

        /* Get the writer from the encoding */
        StreamWriter sw = getStreamWriterPrim(name);

        /* Open it on the output stream and return */
        return sw.open(os, name);
    }

    /**
     * Get a writer for an OutputStream
     *
     * @param  os              The output stream the reader is for
     * @param  name            The name of the decoder
     * @return                 A new writer for the stream
     * @exception UnsupportedEncodingException  If the encoding is not known
     */
    private static StreamWriter getStreamWriterPrim(String name)
        throws UnsupportedEncodingException {
        try {
            return (StreamWriter)getStreamReaderOrWriter(name, "_Writer");
        } catch(ClassCastException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "ClassCastException "+x.getMessage()
/* #endif */
            );
        }
    }

    /**
     * Convert a byte array to a char array
     *
     * @param  buffer          The byte array buffer
     * @param  offset          The offset
     * @param  length          The length
     * @return                 A new char array
     */
    public static char[] byteToCharArray(byte[] buffer, int offset, int length) {
        /*
         * PATCH(j2me-nx-port) 2026-09-23 —— `new String(byte[])` 的编码自动判定。
         *
         * 背景：J2ME 的 `new String(byte[])` 走"平台默认编码"，而手机厂商各家不同
         * （Nokia Asha=ISO8859_1、中文机=GBK、部分移植版=UTF-8）。本移植层把
         * microedition.encoding 定为 **GBK**（模拟中文手机，见 vendor/pluotsorbet/native.js）。
         * 但确实有游戏用 UTF-8 存文本，猜错一次就是整段文字变 U+FFFD / 乱码
         * （实机「Forgotten Warrior 丢文字」：游戏的 1.sn 是 GBK，被当 UTF-8 解，
         * 91 个汉字全成替换字符）。所以这里不硬编码，而是**看字节本身**：
         *
         *   ① 严格合法 UTF-8（含纯 ASCII）→ 按 UTF-8（顺手也是最快的路径）；
         *   ② 否则按默认编码（GBK）解；解出来没有替换字符就用它；
         *   ③ 两种都解不干净（乱数据 / Latin-1）→ 取替换字符少的那个，平手保持旧行为(UTF-8)。
         *
         * 注意：显式指定编码的路径（`new String(b, "GBK")` 等）完全不经过这里，行为不变。
         */
        if (isValidUtf8(buffer, offset, length)) {
            try {
                return byteToCharArray(buffer, offset, length, "UTF-8");
            } catch (UnsupportedEncodingException x) {
                /* UTF-8 不可用（理论上不会）→ 落到默认编码 */
            }
        }

        try {
            char[] dflt = byteToCharArray(buffer, offset, length, defaultEncoding);
            if (countReplacementChar(dflt) == 0) {
                return dflt;
            }
            char[] utf8 = byteToCharArray(buffer, offset, length, "UTF-8");
            return countReplacementChar(utf8) <= countReplacementChar(dflt) ? utf8 : dflt;
        } catch(UnsupportedEncodingException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "Missing default encoding " + defaultEncoding
/* #endif */
            );
        }
    }

    /*
     * PATCH(j2me-nx-port): 严格 UTF-8 合法性校验（只看合法与否，不产出字符）。
     * 故意从严：过长编码(overlong)、代理区 U+D800-DFFF、超出 U+10FFFF 都算非法 ——
     * 放宽任何一条都可能让 GBK 字节被误判成"合法 UTF-8"，那就又回到丢文字的老路。
     */
    private static boolean isValidUtf8(byte[] b, int off, int len) {
        if (b == null || off < 0 || len < 0 || off > b.length - len) {
            return false;
        }
        int end = off + len;
        for (int i = off; i < end; i++) {
            int c = b[i] & 0xff;
            if (c < 0x80) {
                continue;                       /* ASCII 单字节 */
            }
            int need;
            int cp;
            if (c >= 0xc2 && c <= 0xdf) {       /* 0xC0/0xC1 = 过长编码首字节 */
                need = 1;
                cp = c & 0x1f;
            } else if (c >= 0xe0 && c <= 0xef) {
                need = 2;
                cp = c & 0x0f;
            } else if (c >= 0xf0 && c <= 0xf4) { /* 0xF5-0xFF 超范围 */
                need = 3;
                cp = c & 0x07;
            } else {
                return false;
            }
            if (i + need >= end) {
                return false;                   /* 截断 */
            }
            for (int k = 1; k <= need; k++) {
                int cc = b[i + k] & 0xff;
                if ((cc & 0xc0) != 0x80) {
                    return false;               /* 续字节格式错 */
                }
                cp = (cp << 6) | (cc & 0x3f);
            }
            if (need == 1 && cp < 0x80) {
                return false;                   /* 过长编码 */
            }
            if (need == 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) {
                return false;                   /* 过长编码 / 代理区 */
            }
            if (need == 3 && (cp < 0x10000 || cp > 0x10ffff)) {
                return false;                   /* 过长编码 / 超范围 */
            }
            i += need;
        }
        return true;
    }

    /** PATCH(j2me-nx-port): 数一段字符里有多少个 U+FFFD（解码失败的痕迹）。 */
    private static int countReplacementChar(char[] s) {
        int n = 0;
        for (int i = 0; i < s.length; i++) {
            if (s[i] == 0xfffd) {
                n++;
            }
        }
        return n;
    }

    /**
     * Convert a char array to a byte array
     *
     * @param  buffer          The char array buffer
     * @param  offset          The offset
     * @param  length          The length
     * @return                 A new byte array
     */
    public static byte[] charToByteArray(char[] buffer, int offset, int length) {
        try {
            return charToByteArray(buffer, offset, length, defaultEncoding);
        } catch(UnsupportedEncodingException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "Missing default encoding "+defaultEncoding
/* #endif */
            );
        }
    }

    /*
     * Cached variables for byteToCharArray
     */
    private static String lastReaderEncoding;
    private static StreamReader  lastReader;

    /**
     * Convert a byte array to a char array
     *
     * @param  buffer          The byte array buffer
     * @param  offset          The offset
     * @param  length          The length
     * @param  enc             The character encoding
     * @return                 A new char array
     * @exception UnsupportedEncodingException  If the encoding is not known
     */
    public static synchronized char[] byteToCharArray(byte[] buffer, int offset,
        int length, String enc) throws UnsupportedEncodingException {

        if (offset < 0) {
            throw new IndexOutOfBoundsException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       Integer.toString(offset)
/* #endif */
            );
        }

        if (length < 0) {
            throw new IndexOutOfBoundsException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       Integer.toString(length)
/* #endif */
            );
        }

        /* Note: offset or length might be near -1>>>1 */
        if (offset > buffer.length - length) {
            throw new IndexOutOfBoundsException(
/* #ifdef VERBOSE_EXCEPTIONS */                                           
/// skipped                       Integer.toString(offset + length)
/* #endif */
            );
        }

        //Because most cases use ISO8859_1 encoding, we can optimize this case.
        if(enc.compareTo("ISO8859_1") == 0) {
            char[] value = new char[length];
            for(int i=0; i<length; i++) {
                value[i] = (char)(buffer[i+offset] & 0xff);
            }
            return value;
        }

        /* If we don't have a cached reader then make one */
        if (lastReaderEncoding == null || !lastReaderEncoding.equals(enc)) {
            lastReader = getStreamReaderPrim(enc);
            lastReaderEncoding = enc;
        }

        /* Ask the reader for the size the output will be */
        int size = lastReader.sizeOf(buffer, offset, length);

        /* Allocate a buffer of that size */
        char[] outbuf = new char[size];

        /* Open the reader on a ByteArrayInputStream */
        lastReader.open(new ByteArrayInputStream(buffer, offset, length), enc);

        try {
            /* Read the input */
            lastReader.read(outbuf, 0, size);
            /* Close the reader */
            lastReader.close();
        } catch(IOException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "IOException reading reader " +x.getMessage()
/* #endif */
            );
        }

        /* And return the buffer */
        return outbuf;
    }

    /*
     * Cached variables for charToByteArray
     */
    private static String lastWriterEncoding;
    private static StreamWriter lastWriter;

    /**
     * Convert a char array to a byte array
     *
     * @param  buffer          The char array buffer
     * @param  offset          The offset
     * @param  length          The length
     * @param  enc             The character encoding
     * @return                 A new byte array
     * @exception UnsupportedEncodingException  If the encoding is not known
     */
    public static synchronized byte[] charToByteArray(char[] buffer, int offset,
        int length, String enc) throws UnsupportedEncodingException {
        
        //Because most cases use ISO8859_1 encoding, we can optimize this case.
        if(enc.compareTo("ISO8859_1") == 0) {
            char c;
            byte[] value = new byte[length];
            for(int i=0; i<length; i++) {
                c = buffer[i+offset];
                value[i] = (c <= 255) ? (byte)c : (byte)'?';
            }
            return value;
        }

        /* If we don't have a cached writer then make one */
        if (lastWriterEncoding == null || !lastWriterEncoding.equals(enc)) {
            lastWriter = getStreamWriterPrim(enc);
            lastWriterEncoding = enc;
        }

        /* Ask the writer for the size the output will be */
        int size = lastWriter.sizeOf(buffer, offset, length);

        /* Get the output stream */
        ByteArrayOutputStream os = new ByteArrayOutputStream(size);

        /* Open the writer */
        lastWriter.open(os, enc);

        try {
            /* Convert */
            lastWriter.write(buffer, offset, length);
            /* Close the writer */
            lastWriter.close();
        } catch(IOException x) {
            throw new RuntimeException(
/* #ifdef VERBOSE_EXCEPTIONS */
/// skipped                       "IOException writing writer " 
/// skipped                       +x.getMessage()
/* #endif */
            );
        }

        /* Close the output stream */
        try {
            os.close();
        } catch(IOException x) {};

        /* Return the array */
        return os.toByteArray();
    }

    /**
     * Get the internal name for an encoding.
     *
     * @param encodingName encoding name
     *
     * @return internal name for this encoding
     */
    private static String internalNameForEncoding(String encodingName) {
        String internalName;
        String property;

        internalName = normalizeEncodingName(encodingName);

        // The preferred MIME name according to the IANA Charset Registry.
        if (internalName.equals("US_ASCII")) {
            /*
             * US-ASCII is subclass of ISO-8859-1 so we do not need a
             * separate reader for it.
             */
            return "ISO8859_1";
        }

        // The preferred MIME name according to the IANA Charset Registry.
        if (internalName.equals("ISO_8859_1")) {
            return "ISO8859_1";
        }

        /*
         * Since IANA character encoding names can start with a digit
         * and that some Reader class names that do not match the standard
         * name, we have a way to configure alternate names for encodings.
         *
         * Note: The names must normalized, digits, upper case only with "_"
         *       and "_" substituted for ":" and "-".
         *
         * Use the code below only if your system really needs it:
         *
         * property = System.getProperty(internalName + "_InternalEncodingName");
         * if (property != null) {
         *     return property;
         * }
         */

        return internalName;
    }

    /**
     * Converts "-" and ":" in a string to "_" and converts the name
     * to upper case.
     * This is needed because the names of IANA character encodings have
     * characters that are not allowed for java class names and
     * IANA encoding names are not case sensitive.
     *
     * @param encodingName encoding name
     *
     * @return normalized name
     */
    private static String normalizeEncodingName(String encodingName) {
        StringBuffer normalizedName;
        char currentChar;

        normalizedName = new StringBuffer(encodingName);

        for (int i = 0; i < normalizedName.length(); i++) {
            currentChar = normalizedName.charAt(i);

            if (currentChar == '-' || currentChar == ':') {
                normalizedName.setCharAt(i, '_');
            } else {
                normalizedName.setCharAt(i, Character.toUpperCase(currentChar));
            }
        }

        return normalizedName.toString();
    }
}
