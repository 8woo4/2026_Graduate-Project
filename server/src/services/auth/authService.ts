import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import User from '../../models/user/User'
import Wallet from '../../models/user/Wallet'
import EmailVerification from '../../models/auth/EmailVerification'
import SmsVerification from '../../models/auth/SmsVerification'
import LoginRecord from '../../models/auth/LoginRecord'
import { getLocationFromIp } from '../../utils/getLocationFromIp'
import {
  isWalletRegistered,
  registerWalletFor,
  unregisterWallet,
  getAuthNonce,
  getUsableAuthNonce,
  verifySignature as contractVerifySignature,
  buildRegisterMessage,
  hasNonceHistory,
  detachOnChain,
} from '../web3/contractService'
import { sendVerificationEmail } from './emailService'
import { sendVerificationSms } from './smsService'
import { sendNewDeviceAlert } from './emailService'
import { buildLabel } from './trustedDeviceService'
import { Op } from 'sequelize'
import Blacklist from '../../models/auth/Blacklist'
import WithdrawnUser from '../../models/auth/WithdrawnUser'
import sequelize from '../../config/database'
import {
  accountDisplay,
  accountLoginKey,
  identifierDisplay,
  identifierLoginKey,
  type LoginIdentifier,
} from '../../utils/loginIdentifier'

// ─── 이메일 인증 ──────────────────────────────────────────────

// 가입 지갑 서명에 묶는 신원 — 클라이언트(Register.tsx)와 같은 규칙
export const signupIdentity = (email: string | null, phone: string | null): string =>
  email ? email : `phone:${phone ?? ''}`

// 가입 인증 성공 기록의 유효 시간 — 오래전 인증이 기한 없이 가입 근거로 남지 않게 한다
export const SIGNUP_VERIFICATION_WINDOW_MS = 30 * 60 * 1000

// 가입에 쓸 수 있는 이메일인가. 이메일 인증 발송과 가입 둘 다에서 확인한다 —
// 휴대폰 인증으로 가입하면 이메일 발송 단계를 거치지 않으므로 가입 시점에도 같은 검사가 필요하다.
const assertEmailAvailableForSignup = async (email: string): Promise<void> => {
  // 블랙리스트 확인
  const blacklisted = await Blacklist.findOne({ where: { email } })
  if (blacklisted) throw new Error('이용이 제한된 계정입니다')

  // 탈퇴 후 30일 이내 재가입 체크
  const withdrawn = await WithdrawnUser.findOne({
    where: {
      email,
      is_deleted: false,
      expires_at: { [Op.gt]: new Date() },
    },
  })
  if (withdrawn) {
    const daysLeft = Math.ceil(
      (new Date(withdrawn.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    )
    throw new Error(`탈퇴 후 ${daysLeft}일 후에 재가입 가능합니다`)
  }

  // 이메일 중복 확인 (withdrawn 제외)
  const existing = await User.findOne({
    where: { email, status: { [Op.ne]: 'withdrawn' } },
  })
  if (existing) throw new Error('이미 사용 중인 이메일입니다')
}

// 이메일 인증코드 발송 (가입용)
export const sendEmailCode = async (email: string): Promise<void> => {
  await assertEmailAvailableForSignup(email)

  // 기존 미사용 코드 무효화 — 무효화는 is_used 만 바꾼다. 인증 성공(verified_at)과는 별개다.
  await EmailVerification.update(
    { is_used: true },
    { where: { email, is_used: false, purpose: 'SIGNUP' } },
  )

  // 재발송 횟수 확인 (일 5회 제한)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const sendCount = await EmailVerification.count({
    where: {
      email,
      created_at: { [Op.gte]: todayStart },
    },
  })
  if (sendCount >= 5) throw new Error('일일 인증 요청 한도를 초과했습니다')

  // 쿨타임 확인 (1분)
  const lastSent = await EmailVerification.findOne({
    where: { email },
    order: [['created_at', 'DESC']],
  })
  if (lastSent) {
    const diff = Date.now() - new Date(lastSent.created_at!).getTime()
    if (diff < 60 * 1000) throw new Error('1분 후 다시 요청해주세요')
  }

  // 6자리 코드 생성
  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5분

  await EmailVerification.create({
    email,
    code,
    expires_at: expiresAt,
    is_used: false,
    fail_count: 0,
    purpose: 'SIGNUP',
  })
  await sendVerificationEmail(email, code)
}

export const verifyEmailCode = async (
  email: string,
  code: string,
): Promise<void> => {
  const record = await EmailVerification.findOne({
    where: { email, is_used: false, purpose: 'SIGNUP' },
    order: [['created_at', 'DESC']],
  })

  if (!record) throw new Error('인증코드가 존재하지 않습니다')
  if (new Date() > record.expires_at)
    throw new Error('인증코드가 만료되었습니다')

  // 실패 횟수 확인 (5회 초과 시 무효화)
  if (record.fail_count >= 5) {
    await record.update({ is_used: true })
    throw new Error('인증 시도 횟수를 초과했습니다. 코드를 재발급 받으세요')
  }

  if (record.code !== code) {
    await record.increment('fail_count')
    const remaining = 4 - record.fail_count
    throw new Error(`인증코드가 올바르지 않습니다. 남은 시도: ${remaining}회`)
  }

  await record.update({ is_used: true, verified_at: new Date() })
}

// ─── SMS 인증 ────────────────────────────────────────────────

// SMS 인증코드 발송
export const sendSmsCode = async (phone: string): Promise<void> => {
  // 휴대폰 중복 확인
  const existing = await User.findOne({ where: { phone } })
  if (existing) throw new Error('이미 사용 중인 휴대폰 번호입니다')

  // 기존 미사용 코드 무효화(가입용만)
  await SmsVerification.update(
    { is_used: true },
    { where: { phone, is_used: false, purpose: 'SIGNUP' } },
  )

  // 재발송 횟수 확인 (일 5회 제한)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const sendCount = await SmsVerification.count({
    where: {
      phone,
      created_at: { [Op.gte]: todayStart },
    },
  })
  if (sendCount >= 5) throw new Error('일일 인증 요청 한도를 초과했습니다')

  // 쿨타임 확인 (1분)
  const lastSent = await SmsVerification.findOne({
    where: { phone },
    order: [['created_at', 'DESC']],
  })
  if (lastSent) {
    const diff = Date.now() - new Date(lastSent.created_at!).getTime()
    if (diff < 60 * 1000) throw new Error('1분 후 다시 요청해주세요')
  }

  // 6자리 코드 생성
  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5분

  await SmsVerification.create({
    phone,
    code,
    expires_at: expiresAt,
    is_used: false,
    fail_count: 0,
    purpose: 'SIGNUP',
  })
  await sendVerificationSms(phone, code)
}

// SMS 인증코드 검증
export const verifySmsCode = async (
  phone: string,
  code: string,
): Promise<void> => {
  const record = await SmsVerification.findOne({
    where: { phone, is_used: false, purpose: 'SIGNUP' },
    order: [['created_at', 'DESC']],
  })

  if (!record) throw new Error('인증코드가 존재하지 않습니다')
  if (new Date() > record.expires_at)
    throw new Error('인증코드가 만료되었습니다')

  if (record.fail_count >= 5) {
    await record.update({ is_used: true })
    throw new Error('인증 시도 횟수를 초과했습니다. 코드를 재발급 받으세요')
  }

  if (record.code !== code) {
    await record.increment('fail_count')
    const remaining = 4 - record.fail_count
    throw new Error(`인증코드가 올바르지 않습니다. 남은 시도: ${remaining}회`)
  }

  await record.update({ is_used: true, verified_at: new Date() })
}

// ─── 회원가입 ─────────────────────────────────────────────────

export const register = async (
  email: string | null | undefined,
  password: string,
  name: string,
  phone: string | null | undefined,
  walletAddress: string,
  walletSignature: string,
  terms_agreed: boolean,
  privacy_agreed: boolean,
  location_agreed: boolean,
  age_agreed: boolean,
  marketing_agreed: boolean,
) => {
  // 본인 인증 — 이메일 또는 휴대폰 중 하나 이상, 그리고 낸 값은 전부 인증된 값이어야 한다.
  //   - 이메일로 가입하면 이메일이, 휴대폰으로 가입하면 휴대폰 번호가 로그인 아이디가 된다.
  //   - 인증하지 않은 이메일·번호를 받지 않는다. 받으면 남의 이메일·번호를 선점해 그 주인의 가입을 막거나
  //     그 주소로 보안 경보를 보내게 만들 수 있다.
  // 인증 성공(verified_at)이 최근 30분 이내이고, 가입용(SIGNUP)이며, 아직 가입에 쓰이지 않은 기록만 인정한다.
  const emailNorm = typeof email === 'string' && email.trim() ? email.trim() : null
  const phoneNorm = typeof phone === 'string' && phone.trim() ? phone.trim() : null
  if (!emailNorm && !phoneNorm) throw new Error('이메일 또는 휴대폰 인증을 완료해주세요')
  if (emailNorm) await assertEmailAvailableForSignup(emailNorm)
  const since = new Date(Date.now() - SIGNUP_VERIFICATION_WINDOW_MS)
  const emailRecord = emailNorm
    ? await EmailVerification.findOne({
        where: { email: emailNorm, purpose: 'SIGNUP', verified_at: { [Op.gte]: since }, consumed_at: null },
        order: [['verified_at', 'DESC']],
      })
    : null
  const phoneRecord = phoneNorm
    ? await SmsVerification.findOne({
        where: { phone: phoneNorm, purpose: 'SIGNUP', verified_at: { [Op.gte]: since }, consumed_at: null },
        order: [['verified_at', 'DESC']],
      })
    : null
  if (emailNorm && !emailRecord) throw new Error('이메일 인증이 완료되지 않았습니다')
  if (phoneNorm && !phoneRecord) throw new Error('휴대폰 인증이 완료되지 않았습니다')
  if (phoneNorm) {
    const phoneTaken = await User.findOne({ where: { phone: phoneNorm } })
    if (phoneTaken) throw new Error('이미 사용 중인 휴대폰 번호입니다')
  }

  const existingWallet = await Wallet.findOne({
    where: { address: walletAddress },
  })
  if (existingWallet) throw new Error('이미 등록된 지갑 주소입니다')

  const onChainRegistered = await isWalletRegistered(walletAddress)
  if (onChainRegistered) throw new Error('이미 온체인에 등록된 지갑 주소입니다')

  // 탈퇴로 등록 해제된 지갑의 재가입 차단.
  // 컨트랙트는 등록 해제 시 논스를 0 으로 되돌리므로, 같은 지갑을 다시 등록하면 과거에
  // 사용된 0..k 번 서명이 체인 기준으로 다시 유효해진다. 1인 1계정 원칙상 지갑은 계정의
  // 신원이기도 하므로 한 번 계정에 쓰인 지갑은 다른 계정의 신원으로 재사용하지 않는다.
  const previouslyUsed =
    (await hasNonceHistory(walletAddress)) ||
    (await WithdrawnUser.findOne({ where: { wallet_address: { [Op.in]: [walletAddress, walletAddress.toLowerCase()] } } })) !== null
  if (previouslyUsed) throw new Error('이전에 다른 계정에서 사용된 지갑은 재사용할 수 없습니다. 새 지갑으로 가입해주세요')

  // 가입 서명은 로그인 서명과 다른 용도 태그·가입 신원(이메일, 없으면 phone:번호)을 묶은 메시지에 대한 서명이다.
  const message = buildRegisterMessage(walletAddress, signupIdentity(emailNorm, phoneNorm))
  const { recoverMessageAddress } = await import('viem')
  const recovered = await recoverMessageAddress({
    message: { raw: message },
    signature: walletSignature as `0x${string}`,
  })
  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('지갑 서명 검증에 실패했습니다')
  }

  const password_hash = await bcrypt.hash(password, 12)

  // 인증 소비·사용자·지갑 생성을 한 트랜잭션으로 묶는다. 같은 인증으로 동시에 두 번 가입하면
  // 소비 갱신이 한쪽에서만 성공하므로(consumed_at IS NULL 조건) 다른 쪽은 되돌려진다.
  // 온체인 등록은 되돌릴 수 없으므로 DB 쓰기를 마친 뒤 커밋 직전에 수행한다 — 체인 등록이 실패하면
  // 사용자 행도 남지 않는다(이전에는 사용자만 생성되고 지갑이 없는 계정이 남을 수 있었다).
  const t = await sequelize.transaction()
  try {
    const now = new Date()
    const consume = async (model: typeof EmailVerification | typeof SmsVerification, id: number) => {
      const [n] = await (model as any).update(
        { consumed_at: now },
        { where: { id, consumed_at: null }, transaction: t },
      )
      if (n !== 1) throw new Error('이미 사용된 인증입니다. 다시 인증해주세요')
    }
    if (emailRecord) await consume(EmailVerification, emailRecord.id)
    if (phoneRecord) await consume(SmsVerification, phoneRecord.id)

    const user = await User.create({
      email: emailNorm,
      password_hash,
      name,
      phone: phoneNorm,
      role: 'user',
      is_email_verified: emailRecord !== null,
      is_locked: false,
      status: 'active',
      is_phone_verified: phoneRecord !== null,
      terms_agreed,
      privacy_agreed,
      location_agreed,
      age_agreed,
      marketing_agreed,
    }, { transaction: t })

    await Wallet.create({
      user_id: user.id,
      address: walletAddress,
      network: 'sepolia',
      seed_amount: 0,
      is_primary: true,
      linked_at: now,
    }, { transaction: t })

    await registerWalletFor(walletAddress)
    await t.commit()
    return user
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 로그인 ───────────────────────────────────────────────────

// 존재하지 않는 계정에도 동일한 비용의 비교를 수행하기 위한 더미 해시.
// 실제 저장 해시와 같은 cost(12)로 만들어 두어야 응답 시간 차이가 생기지 않는다.
// (평문은 어떤 입력과도 일치하지 않는 무작위 값이다)
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12)

// 1단계: 이메일 + 비밀번호 검증 → nonce 반환
// 로그인 아이디(이메일 또는 휴대폰)로 계정을 찾는다. 실패한 로그인도 계정 기준으로 집계해야 하므로
// 비밀번호 검증과 분리해 컨트롤러가 먼저 호출한다.
//   - 휴대폰은 인증된 번호(is_phone_verified)만 로그인 아이디로 인정한다. 인증 안 된 번호를 아이디로 쓰면
//     남의 번호를 적어 둔 계정으로 그 번호 주인을 사칭할 수 있다.
//   - 같은 번호의 계정이 둘 이상이면(유일 제약 이전 데이터) 어느 쪽인지 정할 수 없으므로 찾지 못한 것으로 본다.
export interface LoginAccount {
  identifier: LoginIdentifier
  user: User | null
  loginKey: string   // 무차별 대입 집계 키(계정 기준)
  display: string    // 이상 로그 표시값(휴대폰은 가림)
}

export const resolveLoginAccount = async (identifier: LoginIdentifier): Promise<LoginAccount> => {
  let user: User | null = null
  if (identifier.kind === 'email') {
    user = await User.findOne({ where: { email: identifier.value } })
  } else {
    const found = await User.findAll({ where: { phone: identifier.value, is_phone_verified: true }, limit: 2 })
    if (found.length === 1) user = found[0]
    else if (found.length > 1) console.warn('[Auth] 같은 휴대폰 번호의 계정이 여럿이라 휴대폰 로그인을 거부함')
  }
  return {
    identifier,
    user,
    loginKey: user ? accountLoginKey(user) : identifierLoginKey(identifier),
    display: user ? accountDisplay(user) : identifierDisplay(identifier),
  }
}

export const loginStep1 = async (account: LoginAccount, password: string) => {
  const { user } = account

  // 계정 열거(enumeration) 억제
  //  1) 잠금·탈퇴 여부를 비밀번호 검증 "이후"에 확인한다. 이전에 확인하면 비밀번호를
  //     모르는 공격자도 응답 문구만으로 그 이메일의 가입 여부를 알 수 있다.
  //  2) 계정이 없어도 더미 해시로 비교를 수행한다. 비교를 건너뛰면 응답 시간이 짧아져
  //     문구가 같아도 타이밍으로 존재 여부가 드러난다.
  const hash = user?.password_hash ?? DUMMY_PASSWORD_HASH
  const isMatch = await bcrypt.compare(password, hash)
  if (!user || !isMatch) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다')

  if (user.is_locked) throw new Error('계정이 잠겼습니다. 관리자에게 문의하세요')
  if (user.status === 'withdrawn') throw new Error('탈퇴한 계정입니다')

  const wallet = await Wallet.findOne({ where: { user_id: user.id, is_primary: true } })
  if (!wallet) throw new Error('지갑이 등록되지 않은 계정입니다')

  const nonce = await getUsableAuthNonce(wallet.address)
  return {
    userId: user.id,
    walletAddress: wallet.address,
    nonce: nonce.toString(),
  }
}

// 2단계: 지갑 서명 검증 → JWT 발급
export const loginStep2 = async (
  userId: number,
  walletAddress: string,
  signature: string,
  ip: string,
  userAgent: string,
  skipSignature = false,
) => {
  const user = await User.findByPk(userId)
  if (!user) throw new Error('유저를 찾을 수 없습니다')
  if (user.is_locked) throw new Error('계정이 잠겼습니다. 관리자에게 문의하세요')
  if (user.status === 'withdrawn') throw new Error('탈퇴한 계정입니다')

  // 서명을 검증할 지갑은 이 계정에 등록된 지갑이어야 한다. 온체인 레지스트리는 "등록된 지갑의
  // 집합"만 알 뿐 지갑과 계정의 대응을 모르므로, 이 대조가 없으면 다른 계정의 지갑 서명도 통과한다.
  const owned = await Wallet.findOne({ where: { user_id: userId, is_primary: true } })
  if (!owned || owned.address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('이 계정에 등록된 지갑이 아닙니다')
  }

  const nonce = await getAuthNonce(walletAddress)

  // 온체인 서명 검증
  // + 추가 신뢰 기기면 스킵
  if (!skipSignature) {
  await contractVerifySignature(walletAddress, nonce, signature)
  sendNewDeviceAlert(user.email, buildLabel(userAgent), ip, new Date()).catch(console.error)
  }

  // 로그인 기록 저장
  await saveLoginRecord(userId, walletAddress, ip, userAgent)


  // JWT 발급
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role })

  const refreshToken = jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET as string,
    { expiresIn: '7d' },
  )

  return { user, accessToken, refreshToken, walletAddress }
}

// ─── 로그인 기록 ──────────────────────────────────────────────

const saveLoginRecord = async (
  userId: number,
  walletAddress: string,
  ip: string,
  userAgent: string,
) => {
  try {
    // 공통 유틸을 쓴다 — 여기서 ip-api 를 직접 호출하던 사본이 있었고, 그 사본은
    // 좌표(lat/lon)를 요청하지 않아 Impossible Travel(M-4) 이 쓸 데이터가 남지 않았다.
    const geo = await getLocationFromIp(ip)

    await LoginRecord.create({
      user_id: userId,
      wallet_address: walletAddress,
      ip_address: ip,
      country: geo.country ?? undefined,
      region: geo.region ?? undefined,
      city: geo.city ?? undefined,
      latitude: geo.lat ?? null,
      longitude: geo.lon ?? null,
      user_agent: userAgent,
      logged_at: new Date(),
    })
  } catch {
    console.error('로그인 기록 저장 실패')
  }
}

// ─── 탈퇴 ─────────────────────────────────────────────────────

export const withdraw = async (userId: number) => {
  const user = await User.findByPk(userId)
  if (!user) throw new Error('유저를 찾을 수 없습니다')

  // is_primary 로 좁히지 않는다 — wallets.user_id 가 unique(1유저 1지갑)라 한 행뿐이고,
  // 플래그가 어긋난 행이 있으면 지갑이 통째로 누락돼 해제도 기록도 되지 않는다.
  const wallet = await Wallet.findOne({ where: { user_id: userId } })
  const walletAddress = wallet?.address

  // 탈퇴는 셋이 함께 끝나야 한다. 중간에 끊기면 "개인정보는 지웠는데 지갑은 남은" 반쪽
  // 상태가 되고, 그 상태는 사용자가 다시 시도해서 고칠 수 없다.
  const t = await sequelize.transaction()
  try {
    // withdrawn_users에 개인정보 이관 — 지갑 주소도 여기 보존된다. 재가입 차단(30일)과
    // 이후의 지갑 재사용 금지 판정이 이 기록을 근거로 하므로, wallets 행을 지워도 안전하다.
    await WithdrawnUser.create({
      original_user_id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone ?? undefined,
      wallet_address: walletAddress ?? undefined,
      withdrawn_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30일 후
      is_deleted: false,
    }, { transaction: t })

    // users 테이블 개인정보 마스킹
    await user.update({
      email: `withdrawn_${user.id}@deleted.com`,
      name: '탈퇴회원',
      phone: null,
      status: 'withdrawn',
      deleted_at: new Date(),
    }, { transaction: t })

    // 지갑 연결 해제. 이메일·이름·번호는 마스킹하면서 지갑 주소만 평문으로 남겨 두면
    // 탈퇴 계정과 지갑의 연결이 그대로 보존된다(지갑 주소도 식별자다).
    if (wallet) await wallet.destroy({ transaction: t })

    await t.commit()
  } catch (err) {
    await t.rollback()
    throw err
  }

  // 온체인 등록 해제는 DB 확정 뒤에 떼어 보낸다. await 하면 응답이 Sepolia RPC 왕복만큼
  // 늦어져 화면이 멈춘 것처럼 보이고, 호출이 실패하면 탈퇴 전체가 거부돼 사용자가
  // 계정을 지울 수조차 없게 된다. 개인정보 삭제가 외부 체인 상태에 묶여서는 안 된다.
  if (walletAddress) {
    detachOnChain('unregisterWallet', () => unregisterWallet(walletAddress))
  }

  return true
}

// ─── 토큰 검증 ───────────────────────────────────────────────

export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, process.env.JWT_SECRET as string)
}

// 액세스 토큰 수명의 단일 출처. 로그인과 토큰 갱신이 각자 수명을 적으면 한쪽만 늘어난다 —
// 갱신 경로가 1시간짜리를 발급해 쿠키(10분)보다 토큰이 오래 살아남던 것이 그 사례다.
export const ACCESS_TOKEN_TTL_SEC = 10 * 60

export const signAccessToken = (payload: { id: number; email?: string | null; role?: string }) =>
  jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: ACCESS_TOKEN_TTL_SEC })

export const verifyRefreshToken = (token: string) => {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET as string)
}
// ─── 마이페이지 휴대폰 인증 ──────────────────────────────────

export const sendPhoneCode = async (userId: number, phone: string): Promise<void> => {
  // 이미 인증된 번호 확인
  const existingUser = await User.findOne({ where: { phone } })
  if (existingUser && existingUser.id !== userId) {
    throw new Error('이미 사용 중인 휴대폰 번호입니다')
  }

  // 기존 미사용 코드 무효화(마이페이지 용도만)
  await SmsVerification.update(
    { is_used: true },
    { where: { phone, is_used: false, purpose: 'PHONE_CHANGE' } },
  )

  // 일 5회 제한
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const sendCount = await SmsVerification.count({
    where: { phone, created_at: { [Op.gte]: todayStart } },
  })
  if (sendCount >= 5) throw new Error('일일 인증 요청 한도를 초과했습니다')

  // 1분 쿨타임
  const lastSent = await SmsVerification.findOne({
    where: { phone },
    order: [['created_at', 'DESC']],
  })
  if (lastSent) {
    const diff = Date.now() - new Date(lastSent.created_at!).getTime()
    if (diff < 60 * 1000) throw new Error('1분 후 다시 요청해주세요')
  }

  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

  const record = await SmsVerification.create({ phone, code, expires_at: expiresAt, is_used: false, fail_count: 0, purpose: 'PHONE_CHANGE' })
  try {
    await sendVerificationSms(phone, code)
  } catch (smsError: any) {
    await record.destroy()
    console.error('[SMS 발송 실패]', smsError?.message ?? smsError)
    throw new Error('SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요')
  }
}

export const verifyPhoneCode = async (userId: number, phone: string, code: string): Promise<void> => {
  const record = await SmsVerification.findOne({
    where: { phone, is_used: false, purpose: 'PHONE_CHANGE' },
    order: [['created_at', 'DESC']],
  })

  if (!record) throw new Error('인증코드가 존재하지 않습니다')
  if (new Date() > record.expires_at) throw new Error('인증코드가 만료되었습니다')

  if (record.fail_count >= 5) {
    await record.update({ is_used: true })
    throw new Error('인증 시도 횟수를 초과했습니다. 코드를 재발급 받으세요')
  }

  if (record.code !== code) {
    await record.increment('fail_count')
    const remaining = 4 - record.fail_count
    throw new Error(`인증코드가 올바르지 않습니다. 남은 시도: ${remaining}회`)
  }

  await record.update({ is_used: true, verified_at: new Date() })

  // 유저 휴대폰 번호 저장 + 인증 완료 처리
  await User.update(
    { phone, is_phone_verified: true },
    { where: { id: userId } },
  )
}

// ─── 닉네임 중복 확인 ────────────────────────────────────────
export const checkNicknameAvailable = async (nickname: string, excludeUserId?: number): Promise<void> => {
  if (!/^[a-zA-Z0-9가-힣_]{2,20}$/.test(nickname)) {
    throw new Error('닉네임은 2~20자, 한글/영문/숫자/밑줄(_)만 사용 가능합니다')
  }
  const where: any = { nickname }
  const existing = await User.findOne({ where })
  if (existing && existing.id !== excludeUserId) {
    throw new Error('이미 사용 중인 닉네임입니다')
  }
}

// ─── 마이페이지 이메일 변경 ──────────────────────────────────

export const sendEmailChangeCode = async (userId: number, newEmail: string): Promise<void> => {
  // 1달 변경 제한 체크
  const user = await User.findByPk(userId)
  if (!user) throw new Error('사용자를 찾을 수 없습니다')

  if (user.email_changed_at) {
    const daysSince = (Date.now() - new Date(user.email_changed_at).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < 30) {
      const daysLeft = Math.ceil(30 - daysSince)
      throw new Error(`이메일은 변경 후 30일이 지나야 다시 변경할 수 있습니다. (${daysLeft}일 남음)`)
    }
  }

  // 새 이메일 형식 확인
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) throw new Error('올바른 이메일 형식이 아닙니다')

  // 이미 사용 중인 이메일인지 확인 (본인 제외)
  const existing = await User.findOne({ where: { email: newEmail, status: { [Op.ne]: 'withdrawn' } } })
  if (existing && existing.id !== userId) throw new Error('이미 사용 중인 이메일입니다')

  // 기존 미사용 코드 무효화
  await EmailVerification.update({ is_used: true }, { where: { email: newEmail, is_used: false, purpose: 'EMAIL_CHANGE' } })

  // 일 5회 제한
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const sendCount = await EmailVerification.count({ where: { email: newEmail, created_at: { [Op.gte]: todayStart } } })
  if (sendCount >= 5) throw new Error('일일 인증 요청 한도를 초과했습니다')

  // 1분 쿨타임
  const lastSent = await EmailVerification.findOne({ where: { email: newEmail }, order: [['created_at', 'DESC']] })
  if (lastSent) {
    const diff = Date.now() - new Date(lastSent.created_at!).getTime()
    if (diff < 60 * 1000) throw new Error('1분 후 다시 요청해주세요')
  }

  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
  await EmailVerification.create({ email: newEmail, code, expires_at: expiresAt, is_used: false, fail_count: 0, purpose: 'EMAIL_CHANGE' })
  await sendVerificationEmail(newEmail, code)
}

export const verifyEmailChange = async (userId: number, newEmail: string, code: string): Promise<void> => {
  // 1달 제한 재확인 (코드 발송~검증 사이 우회 방지)
  const user = await User.findByPk(userId)
  if (!user) throw new Error('사용자를 찾을 수 없습니다')

  if (user.email_changed_at) {
    const daysSince = (Date.now() - new Date(user.email_changed_at).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < 30) {
      const daysLeft = Math.ceil(30 - daysSince)
      throw new Error(`이메일은 변경 후 30일이 지나야 다시 변경할 수 있습니다. (${daysLeft}일 남음)`)
    }
  }

  // 이메일 중복 재확인
  const existing = await User.findOne({ where: { email: newEmail, status: { [Op.ne]: 'withdrawn' } } })
  if (existing && existing.id !== userId) throw new Error('이미 사용 중인 이메일입니다')

  // 인증코드 검증
  const record = await EmailVerification.findOne({ where: { email: newEmail, is_used: false, purpose: 'EMAIL_CHANGE' }, order: [['created_at', 'DESC']] })
  if (!record) throw new Error('인증코드가 존재하지 않습니다')
  if (new Date() > record.expires_at) throw new Error('인증코드가 만료되었습니다')
  if (record.fail_count >= 5) {
    await record.update({ is_used: true })
    throw new Error('인증 시도 횟수를 초과했습니다. 코드를 재발급 받으세요')
  }
  if (record.code !== code) {
    await record.increment('fail_count')
    const remaining = 4 - record.fail_count
    throw new Error(`인증코드가 올바르지 않습니다. 남은 시도: ${remaining}회`)
  }

  await record.update({ is_used: true, verified_at: new Date() })

  // 이메일 업데이트 + 변경일 기록. 휴대폰으로 가입해 이메일이 미인증이던 사용자도 이 흐름(현재 이메일 그대로)으로 인증을 마친다.
  await User.update({ email: newEmail, email_changed_at: new Date(), is_email_verified: true }, { where: { id: userId } })
}
