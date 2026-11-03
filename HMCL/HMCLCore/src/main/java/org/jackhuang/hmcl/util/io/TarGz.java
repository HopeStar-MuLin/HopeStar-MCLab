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
package org.jackhuang.hmcl.util.io;

import org.jetbrains.annotations.NotNullByDefault;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.GZIPInputStream;

/// 解开 `.tar.gz`。
///
/// <p>JDK 自带 gzip 却没有 tar，为偶尔一个发行包引 commons-compress 不划算。
/// 这里只实现 ustar 的常用部分：
/// <ul>
///   <li>普通文件（类型 `0` / `\0` / `7`）与目录（`5`）；</li>
///   <li>`prefix` 字段拼长路径（ustar 把超过 100 字节的路径拆成两段存）；</li>
///   <li>其余类型（符号链接、设备节点、GNU 长名扩展块）一律跳过。</li>
/// </ul>
///
/// <p>**不保留权限位**：调用方是 Windows 上的启动器，可执行位没有意义。
@NotNullByDefault
public final class TarGz {

    private TarGz() {
    }

    /// 解压到 `target`。目录不存在会创建；已存在的同名文件会被覆盖。
    ///
    /// @throws IOException 压缩包损坏、条目越界（`../` 穿越）或读写失败
    public static void extract(Path archive, Path target) throws IOException {
        Files.createDirectories(target);
        Path root = target.toAbsolutePath().normalize();

        try (GZIPInputStream gz = new GZIPInputStream(Files.newInputStream(archive), 64 * 1024)) {
            byte[] header = new byte[512];
            while (true) {
                int read = readFully(gz, header);
                if (read < 512 || isZeroBlock(header)) {
                    // 读到短读或空块：tar 的结束标记是两个全零块，见到一个就够了
                    break;
                }

                String name = readString(header, 0, 100);
                long size = readOctal(header, 124, 12);
                char type = (char) (header[156] & 0xff);
                String prefix = readString(header, 345, 155);
                if (!prefix.isEmpty()) {
                    name = prefix + "/" + name;
                }

                name = name.replace('\\', '/');
                while (name.startsWith("./")) {
                    name = name.substring(2);
                }

                Path dest = root.resolve(name).normalize();
                // 压缩包里的路径不能跑出目标目录（`../../evil` 这类）
                if (!dest.startsWith(root)) {
                    throw new IOException("压缩包里出现越界路径：" + name);
                }

                if (type == '5') {
                    Files.createDirectories(dest);
                } else if (type == 0 || type == '0' || type == '7') {
                    Path parent = dest.getParent();
                    if (parent != null) {
                        Files.createDirectories(parent);
                    }
                    try (OutputStream out = Files.newOutputStream(dest)) {
                        copyExactly(gz, out, size);
                    }
                } else {
                    skipExactly(gz, size);
                }

                // 每条记录按 512 字节对齐
                long padding = (512 - (size % 512)) % 512;
                if (padding > 0) {
                    skipExactly(gz, padding);
                }
            }
        }
    }

    private static int readFully(InputStream in, byte[] buffer) throws IOException {
        int offset = 0;
        while (offset < buffer.length) {
            int n = in.read(buffer, offset, buffer.length - offset);
            if (n < 0) {
                break;
            }
            offset += n;
        }
        return offset;
    }

    private static void copyExactly(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long left = size;
        while (left > 0) {
            int n = in.read(buffer, 0, (int) Math.min(buffer.length, left));
            if (n < 0) {
                throw new IOException("压缩包提前结束");
            }
            out.write(buffer, 0, n);
            left -= n;
        }
    }

    private static void skipExactly(InputStream in, long size) throws IOException {
        long left = size;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped <= 0) {
                if (in.read() < 0) {
                    throw new IOException("压缩包提前结束");
                }
                skipped = 1;
            }
            left -= skipped;
        }
    }

    private static boolean isZeroBlock(byte[] block) {
        for (byte b : block) {
            if (b != 0) {
                return false;
            }
        }
        return true;
    }

    private static String readString(byte[] block, int offset, int length) {
        int end = offset;
        while (end < offset + length && block[end] != 0) {
            end++;
        }
        return new String(block, offset, end - offset, StandardCharsets.UTF_8).trim();
    }

    private static long readOctal(byte[] block, int offset, int length) {
        String text = readString(block, offset, length).trim();
        if (text.isEmpty()) {
            return 0;
        }
        try {
            return Long.parseLong(text, 8);
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
