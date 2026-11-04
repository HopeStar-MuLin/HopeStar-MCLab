// Package room 把用户口头传递的「房间号」确定性地映射成 EasyTier 的网络参数。
// 设计目标是零服务端：任何两个客户端输入相同房间号，必然得到相同的
// network-name 与 network-secret，从而进入同一个虚拟网络。
package room

import (
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// nameSalt 与 secretSalt 是协议的一部分，一旦改动会导致新旧版本无法互通。
// 它们不是密钥，只是防止房间号被直接当成网络名猜测。
const (
	nameSalt   = "mclab-lan/room-name/v1"
	secretSalt = "mclab-lan/room-secret/v1"
	secretPad  = "mclab-lan/2026"
)

var (
	roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{4,32}$`)
	b32         = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// Room 是对外暴露的派生结果。
type Room struct {
	ID       string `json:"id"`
	Network  string `json:"network"`
	Secret   string `json:"-"`
	Password string `json:"-"`
}

// ErrInvalidRoom 表示房间号不符合格式要求。
var ErrInvalidRoom = errors.New("房间号需为 4-32 位字母、数字、下划线或短横线")

// Generate 生成一个方便口头传达的 6 位数字房间号。
// 纯数字只有一百万种组合，配合 secret 派生后不同房间不会串线，
// 但用户在极小概率下可能撞到别人的房间，因此界面同时支持自定义房间号。
func Generate() string {
	n := rand.Intn(900000) + 100000
	return strconv.Itoa(n)
}

// Derive 把房间号与可选口令派生成 EasyTier 的 network-name / network-secret。
// 同一组输入在任何设备上都会得到相同结果，这是无服务端组网的前提。
func Derive(id, password string) (Room, error) {
	id = strings.TrimSpace(id)
	if !roomPattern.MatchString(id) {
		return Room{}, ErrInvalidRoom
	}

	nameHash := sha256.Sum256([]byte(nameSalt + "|" + strings.ToLower(id)))
	// base32 结果是大写，EasyTier 的网络名建议用小写字母加数字。
	network := "mclab-" + strings.ToLower(b32.EncodeToString(nameHash[:]))[:12]

	secretHash := sha256.Sum256([]byte(secretSalt + "|" + id + "|" + password + "|" + secretPad))
	secret := hex.EncodeToString(secretHash[:])[:32]

	return Room{ID: id, Network: network, Secret: secret, Password: password}, nil
}

// Addresses 根据虚拟网段推导本节点与房主的虚拟 IP。
// 房主固定占用网段第 1 个可用地址，客户端按设备名散列到 2-251，
// 这样同一台机器重连后 IP 不变，启动器里存的服务器地址不会失效。
type Addresses struct {
	Host string
	Self string
}

// Allocate 计算虚拟地址。deviceSeed 建议传主机名，保证同机稳定。
func Allocate(cidr, roomID, deviceSeed string, isHost bool) (Addresses, error) {
	base, err := networkBase(cidr)
	if err != nil {
		return Addresses{}, err
	}
	host := offsetIP(base, 1)
	if isHost {
		return Addresses{Host: host, Self: host}, nil
	}

	h := sha256.Sum256([]byte("mclab-lan/ip/v1|" + roomID + "|" + deviceSeed))
	slot := int(h[0])<<8 | int(h[1])
	offset := 2 + slot%250 // 2..251，避开 .1 与广播地址
	return Addresses{Host: host, Self: offsetIP(base, offset)}, nil
}

// networkBase 取出 CIDR 的网络地址，并保证前缀不长于 /24，
// 否则可用主机位不足以做散列分配。
func networkBase(cidr string) (net.IP, error) {
	ip, ipnet, err := net.ParseCIDR(strings.TrimSpace(cidr))
	if err != nil {
		return nil, fmt.Errorf("虚拟网段 %q 无效: %w", cidr, err)
	}
	ones, bits := ipnet.Mask.Size()
	if bits != 32 {
		return nil, errors.New("虚拟网段必须是 IPv4")
	}
	if ones > 24 {
		return nil, errors.New("虚拟网段前缀不能大于 /24")
	}
	return ip.Mask(ipnet.Mask).To4(), nil
}

// offsetIP 从网络地址起偏移。调用方保证 offset 不超过 251，
// 因此进位最多影响倒数第二段。
func offsetIP(base net.IP, offset int) string {
	b := make(net.IP, 4)
	copy(b, base)
	v := int(b[3]) + offset
	if v > 255 {
		b[2] = byte(int(b[2]) + v/256)
		v %= 256
	}
	b[3] = byte(v)
	return b.String()
}
