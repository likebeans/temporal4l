import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Minus, Plus, ShoppingBag } from 'lucide-react';
import { PRODUCTS, SCENARIOS } from '../../shared/types';
import type { OrderInput, ProductId, Scenario } from '../../shared/types';
import { formatMoney } from '../format';

interface OrderFormProps {
  connected: boolean;
  pending: boolean;
  requestError: string | null;
  onSubmit: (input: OrderInput) => Promise<void>;
}

interface FormErrors {
  customerName?: string;
  quantity?: string;
  approvalTimeoutSeconds?: string;
}

const initialInput: OrderInput = {
  customerName: '',
  productId: PRODUCTS[0].id,
  quantity: 1,
  scenario: 'normal',
  approvalTimeoutSeconds: 120,
};

export function OrderForm({ connected, pending, requestError, onSubmit }: OrderFormProps) {
  const [input, setInput] = useState<OrderInput>(initialInput);
  const [errors, setErrors] = useState<FormErrors>({});
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const selectedProduct = useMemo(
    () => PRODUCTS.find((product) => product.id === input.productId) ?? PRODUCTS[0],
    [input.productId],
  );
  const total = selectedProduct.price * input.quantity;

  function setField<K extends keyof OrderInput>(key: K, value: OrderInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
    if (key in errors) {
      setErrors((current) => ({ ...current, [key]: undefined }));
    }
  }

  function selectScenario(scenario: Scenario) {
    setInput((current) => ({
      ...current,
      scenario,
      approvalTimeoutSeconds:
        scenario === 'timeout' ? 15 : current.approvalTimeoutSeconds === 15 ? 120 : current.approvalTimeoutSeconds,
    }));
    if (scenario === 'timeout') {
      setErrors((current) => ({ ...current, approvalTimeoutSeconds: undefined }));
    }
  }

  function validate(): FormErrors {
    const nextErrors: FormErrors = {};
    if (!input.customerName.trim()) {
      nextErrors.customerName = '请输入客户姓名。';
    } else if (input.customerName.trim().length > 40) {
      nextErrors.customerName = '客户姓名不能超过 40 个字符。';
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) {
      nextErrors.quantity = '数量需为 1 到 10 之间的整数。';
    }
    if (
      !Number.isInteger(input.approvalTimeoutSeconds) ||
      input.approvalTimeoutSeconds < 5 ||
      input.approvalTimeoutSeconds > 600
    ) {
      nextErrors.approvalTimeoutSeconds = '等待时间需为 5 到 600 秒。';
    }
    return nextErrors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      window.requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    await onSubmit({ ...input, customerName: input.customerName.trim() });
  }

  const errorItems = Object.entries(errors).filter((entry): entry is [keyof FormErrors, string] => Boolean(entry[1]));

  return (
    <section className="panel order-builder" aria-labelledby="create-order-title">
      <div className="panel__heading">
        <div className="panel__number" aria-hidden="true">01</div>
        <div>
          <p className="panel__kicker">Start a workflow</p>
          <h2 id="create-order-title">创建实验订单</h2>
        </div>
      </div>

      <form className="order-form" onSubmit={handleSubmit} noValidate>
        {errorItems.length > 0 && (
          <div className="form-alert" role="alert" tabIndex={-1} ref={errorSummaryRef}>
            <strong>请检查以下内容</strong>
            <ul>
              {errorItems.map(([field, message]) => (
                <li key={field}>
                  <a href={`#${field}`}>{message}</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="field">
          <label htmlFor="customerName">客户姓名</label>
          <input
            id="customerName"
            name="customerName"
            type="text"
            value={input.customerName}
            autoComplete="name"
            maxLength={40}
            placeholder="例如：林小满"
            aria-invalid={Boolean(errors.customerName)}
            aria-describedby={errors.customerName ? 'customerName-error' : undefined}
            onChange={(event) => setField('customerName', event.target.value)}
          />
          {errors.customerName && <p className="field__error" id="customerName-error">{errors.customerName}</p>}
        </div>

        <div className="field">
          <label htmlFor="productId">选择商品</label>
          <div className="select-wrap">
            <select
              id="productId"
              name="productId"
              value={input.productId}
              onChange={(event) => setField('productId', event.target.value as ProductId)}
            >
              {PRODUCTS.map((product) => (
                <option value={product.id} key={product.id}>
                  {product.name} · {formatMoney(product.price)}
                </option>
              ))}
            </select>
          </div>
          <p className="field__hint">{selectedProduct.description}</p>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="quantity">数量</label>
            <div className="stepper">
              <button
                type="button"
                aria-label="减少数量"
                disabled={input.quantity <= 1}
                onClick={() => setField('quantity', Math.max(1, input.quantity - 1))}
              >
                <Minus size={16} aria-hidden="true" />
              </button>
              <input
                id="quantity"
                name="quantity"
                type="number"
                min="1"
                max="10"
                inputMode="numeric"
                value={input.quantity}
                aria-invalid={Boolean(errors.quantity)}
                aria-describedby={errors.quantity ? 'quantity-error' : undefined}
                onChange={(event) => setField('quantity', Number(event.target.value))}
              />
              <button
                type="button"
                aria-label="增加数量"
                disabled={input.quantity >= 10}
                onClick={() => setField('quantity', Math.min(10, input.quantity + 1))}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            {errors.quantity && <p className="field__error" id="quantity-error">{errors.quantity}</p>}
          </div>
          <div className="order-total" aria-label={`订单合计 ${formatMoney(total)}`}>
            <span>订单合计</span>
            <strong>{formatMoney(total)}</strong>
          </div>
        </div>

        <fieldset className="scenario-fieldset">
          <legend>选择实验情景</legend>
          <div className="scenario-list">
            {SCENARIOS.map((scenario) => (
              <label className={`scenario-option${input.scenario === scenario.id ? ' is-selected' : ''}`} key={scenario.id}>
                <input
                  type="radio"
                  name="scenario"
                  value={scenario.id}
                  checked={input.scenario === scenario.id}
                  onChange={() => selectScenario(scenario.id)}
                />
                <span className="scenario-option__radio" aria-hidden="true" />
                <span>
                  <strong>{scenario.label}</strong>
                  <small>{scenario.description}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="approvalTimeoutSeconds">人工确认等待时间</label>
          <div className="input-suffix">
            <input
              id="approvalTimeoutSeconds"
              name="approvalTimeoutSeconds"
              type="number"
              min="5"
              max="600"
              inputMode="numeric"
              value={input.approvalTimeoutSeconds}
              readOnly={input.scenario === 'timeout'}
              aria-readonly={input.scenario === 'timeout'}
              aria-invalid={Boolean(errors.approvalTimeoutSeconds)}
              aria-describedby={errors.approvalTimeoutSeconds ? 'approvalTimeoutSeconds-error' : 'approvalTimeoutSeconds-hint'}
              onChange={(event) => setField('approvalTimeoutSeconds', Number(event.target.value))}
            />
            <span>秒</span>
          </div>
          {errors.approvalTimeoutSeconds ? (
            <p className="field__error" id="approvalTimeoutSeconds-error">{errors.approvalTimeoutSeconds}</p>
          ) : (
            <p className="field__hint" id="approvalTimeoutSeconds-hint">
              {input.scenario === 'timeout'
                ? '此情景固定为 15 秒，切换其他情景后可调整。'
                : '默认 120 秒，可设置 5 到 600 秒。'}
            </p>
          )}
        </div>

        {requestError && <p className="request-error" role="alert">{requestError}</p>}

        <button className="primary-button" type="submit" disabled={!connected || pending}>
          {pending ? (
            <>
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
              正在启动 Workflow…
            </>
          ) : (
            <>
              <ShoppingBag size={18} aria-hidden="true" />
              启动订单 Workflow
              <ArrowRight size={17} aria-hidden="true" />
            </>
          )}
        </button>
        {!connected && <p className="submit-hint">Temporal 与 Worker 就绪后即可创建订单。</p>}
      </form>
    </section>
  );
}
