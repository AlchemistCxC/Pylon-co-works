import { useMemo, useState } from 'react'
import { DEFAULT_INPUT_PREDICTION_SETTINGS, loadInputPredictionSettings, saveInputPredictionSettings, createStandalonePredictionProvider, type InputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettings.ts'

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="sess-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

export default function InputPredictionSettingsPanel() {
  const [settings, setSettings] = useState<InputPredictionSettings>(() => loadInputPredictionSettings())
  const [status, setStatus] = useState<string>('')
  const update = <K extends keyof InputPredictionSettings>(key: K, value: InputPredictionSettings[K]) => {
    setSettings(previous => {
      const next = { ...previous, [key]: value }
      saveInputPredictionSettings(next)
      return next
    })
    setStatus('已保存')
  }
  const reset = () => { saveInputPredictionSettings(DEFAULT_INPUT_PREDICTION_SETTINGS); setSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS }); setStatus('已恢复默认') }
  const test = async () => {
    setStatus('测试中…')
    try {
      const value = await createStandalonePredictionProvider().predict({ sessionId: 'settings-test', draft: '', history: [], messages: [], signal: new AbortController().signal })
      setStatus(value ? `连接成功：${value}` : '未返回预测（请检查地址、密钥和模型）')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  const configured = useMemo(() => Boolean(settings.enabled && settings.baseUrl && settings.apiKey && settings.model), [settings])
  return <div className="input-prediction-settings settings-surface">
    <div className="agent-settings-heading"><div><h3>输入预测服务</h3><p>独立于 ACP Agent 的 OpenAI 兼容 Chat Completions 服务。配置后，输入栏会按低频策略请求下一句预测。</p></div></div>
    <div className="set-hint">API Key 仅用于请求该服务，保存在本机设置中；不开启或配置不完整时不会发起网络请求。</div>
    <section className="set-group"><div className="set-group-title">连接</div>
      <Field label="预测来源"><select className="set-select" value={settings.mode} onChange={event => update('mode', event.target.value as InputPredictionSettings['mode'])}><option value="auto">自动（优先 ACP Fork）</option><option value="fork">仅 ACP Fork</option><option value="standalone">仅独立模型</option><option value="off">关闭预测</option></select></Field>
      <Field label="启用独立服务"><input type="checkbox" checked={settings.enabled} onChange={event => update('enabled', event.target.checked)} /></Field>
      <Field label="Base URL" hint="例如 https://api.openai.com/v1 或本地 sidecar 地址"><input className="set-input set-input-wide" value={settings.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" /></Field>
      <Field label="API Key"><input className="set-input set-input-wide" type="password" value={settings.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder="sk-…" autoComplete="off" /></Field>
      <Field label="模型"><input className="set-input set-input-wide" value={settings.model} onChange={event => update('model', event.target.value)} placeholder="gpt-4o-mini" /></Field>
      <Field label="Endpoint 路径" hint="兼容大多数 OpenAI API 网关"><input className="set-input set-input-wide" value={settings.endpointPath} onChange={event => update('endpointPath', event.target.value)} /></Field>
    </section>
    <section className="set-group"><div className="set-group-title">生成参数</div>
      <Field label="推理等级"><select className="set-select" value={settings.reasoningEffort} onChange={event => update('reasoningEffort', event.target.value as InputPredictionSettings['reasoningEffort'])}><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option></select></Field>
      <Field label="Temperature"><input className="set-num" type="number" min="0" max="2" step="0.05" value={settings.temperature} onChange={event => update('temperature', event.target.valueAsNumber)} /></Field>
      <Field label="Top P"><input className="set-num" type="number" min="0" max="1" step="0.05" value={settings.topP} onChange={event => update('topP', event.target.valueAsNumber)} /></Field>
      <Field label="最大输出 Token"><input className="set-num" type="number" min="1" max="4096" step="1" value={settings.maxTokens} onChange={event => update('maxTokens', event.target.valueAsNumber)} /></Field>
      <Field label="频率惩罚"><input className="set-num" type="number" min="-2" max="2" step="0.1" value={settings.frequencyPenalty} onChange={event => update('frequencyPenalty', event.target.valueAsNumber)} /></Field>
      <Field label="存在惩罚"><input className="set-num" type="number" min="-2" max="2" step="0.1" value={settings.presencePenalty} onChange={event => update('presencePenalty', event.target.valueAsNumber)} /></Field>
      <Field label="Seed" hint="留空表示由服务端随机"><input className="set-num" type="number" value={settings.seed ?? ''} onChange={event => update('seed', event.target.value === '' ? null : event.target.valueAsNumber)} /></Field>
      <Field label="停止序列" hint="多个值用逗号分隔"><input className="set-input set-input-wide" value={settings.stop} onChange={event => update('stop', event.target.value)} placeholder="\n, END" /></Field>
    </section>
    <section className="set-group"><div className="set-group-title">上下文与请求</div>
      <Field label="发送历史消息"><input type="checkbox" checked={settings.includeHistory} onChange={event => update('includeHistory', event.target.checked)} /></Field>
      <Field label="历史条数"><input className="set-num" type="number" min="1" max="100" value={settings.maxHistoryItems} onChange={event => update('maxHistoryItems', event.target.valueAsNumber)} /></Field>
      <Field label="历史字符上限"><input className="set-num" type="number" min="100" max="20000" step="100" value={settings.maxHistoryChars} onChange={event => update('maxHistoryChars', event.target.valueAsNumber)} /></Field>
      <Field label="超时（毫秒）"><input className="set-num" type="number" min="1000" max="60000" step="500" value={settings.timeoutMs} onChange={event => update('timeoutMs', event.target.valueAsNumber)} /></Field>
      <Field label="系统提示词"><textarea className="set-textarea" rows={3} value={settings.systemPrompt} onChange={event => update('systemPrompt', event.target.value)} /></Field>
      <Field label="自定义请求头" hint="JSON 对象，例如 {&quot;X-Api-Key&quot;:&quot;…&quot;}"><textarea className="set-textarea" rows={2} value={settings.headersJson} onChange={event => update('headersJson', event.target.value)} /></Field>
    </section>
    <div className="cwd-settings-footer"><span className="set-hint" role="status">{status || (configured ? '配置完整' : '尚未配置完整')}</span><div className="sess-field-actions"><button type="button" className="settings-action" onClick={reset}>恢复默认</button><button type="button" className="settings-action primary" disabled={!configured} onClick={() => void test()}>测试连接</button></div></div>
  </div>
}
