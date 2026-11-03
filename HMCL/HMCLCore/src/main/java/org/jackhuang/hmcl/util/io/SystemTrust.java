package org.jackhuang.hmcl.util.io;

import javax.net.ssl.CertPathTrustManagerParameters;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Enumeration;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 信任「JDK 自带 + 操作系统根证书库」的 TLS 上下文。
///
/// Java 默认只读 `$JAVA_HOME/lib/security/cacerts`，而浏览器、curl、.NET 读的是
/// 操作系统证书库。两者的差集在装了本地加速、企业代理或抓包工具的机器上不是空的：
/// 那些工具的根证书装在系统库里，于是浏览器能开 GitHub，Java 却报
/// `PKIX path building failed`。
///
/// 这里只补信任锚，校验规则一点没放松 —— 仍然走 PKIX，仍然带
/// [TLSSecurity] 的被攻破 CA 公钥黑名单。
public final class SystemTrust {

    private SystemTrust() {
    }

    /// 构造过一次就不再重复读证书库：两个 KeyStore 加起来上百条，每次请求读一遍没意义。
    private static volatile SSLContext cached;
    private static volatile boolean built;

    /// 合并后的上下文。构造失败返回 `null`，调用方应退回默认上下文，不要因此让请求失败。
    public static SSLContext context() {
        if (built) {
            return cached;
        }
        synchronized (SystemTrust.class) {
            if (!built) {
                try {
                    cached = build();
                } catch (Exception e) {
                    LOG.warning("cannot build system trust context", e);
                    cached = null;
                }
                built = true;
            }
            return cached;
        }
    }

    private static SSLContext build() throws Exception {
        KeyStore merged = KeyStore.getInstance(KeyStore.getDefaultType());
        merged.load(null, null);

        int jdk = copy(openJdkCacerts(), merged, "jdk-");
        int os = copy(openSystemRoots(), merged, "os-");
        LOG.info("trust store merged: jdk=" + jdk + ", os=" + os + ", total=" + merged.size());

        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init(new CertPathTrustManagerParameters(TLSSecurity.createParameters(merged)));

        SSLContext context = SSLContext.getInstance("TLS");
        context.init(TLSSecurity.createKeyManagers(), factory.getTrustManagers(), null);
        return context;
    }

    /// JDK 自带的 cacerts。存在性不确定（个别精简版 JDK 会删掉），拿不到就当没有。
    private static KeyStore openJdkCacerts() {
        String home = System.getProperty("java.home");
        if (home == null || home.isBlank()) {
            return null;
        }
        Path file = Path.of(home, "lib", "security", "cacerts");
        if (!Files.isRegularFile(file)) {
            return null;
        }
        try (InputStream in = Files.newInputStream(file)) {
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(in, "changeit".toCharArray());
            return store;
        } catch (Exception e) {
            LOG.warning("cannot read " + file, e);
            return null;
        }
    }

    /// 系统根证书库。Windows 是 `Windows-ROOT`，macOS 是 `KeychainStore`；
    /// Linux 各发行版一般已经把系统根合并进 JDK 的 cacerts，拿不到就算了。
    private static KeyStore openSystemRoots() {
        for (String type : new String[]{"Windows-ROOT", "KeychainStore"}) {
            try {
                KeyStore store = KeyStore.getInstance(type);
                store.load(null, null);
                return store;
            } catch (Exception ignored) {
                // 当前平台没有这种库，试下一个
            }
        }
        return null;
    }

    /// 只搬 CA 证书。系统库里混着站点的叶子证书，它们不能当信任锚用，
    /// 搬进去只会让 PKIX 在校验时多绕一圈。
    private static int copy(KeyStore from, KeyStore to, String prefix) throws Exception {
        if (from == null) {
            return 0;
        }
        int added = 0;
        for (Enumeration<String> aliases = from.aliases(); aliases.hasMoreElements(); ) {
            String alias = aliases.nextElement();
            if (!from.isCertificateEntry(alias)) {
                continue;
            }
            Certificate certificate = from.getCertificate(alias);
            if (!(certificate instanceof X509Certificate x509) || x509.getBasicConstraints() < 0) {
                continue;
            }
            to.setCertificateEntry(prefix + alias, certificate);
            added++;
        }
        return added;
    }
}
