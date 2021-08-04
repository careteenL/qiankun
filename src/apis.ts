import { noop } from 'lodash';
import type { ParcelConfigObject } from 'single-spa';
import { mountRootParcel, registerApplication, start as startSingleSpa } from 'single-spa';
import type { ObjectType } from './interfaces';
import type { FrameworkConfiguration, FrameworkLifeCycles, LoadableApp, MicroApp, RegistrableApp } from './interfaces';
import type { ParcelConfigObjectGetter } from './loader';
import { loadApp } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainer, getXPathForElement, toArray } from './utils';

let microApps: Array<RegistrableApp<Record<string, unknown>>> = [];

// eslint-disable-next-line import/no-mutable-exports
export let frameworkConfiguration: FrameworkConfiguration = {};

let started = false;
const defaultUrlRerouteOnly = true;

const frameworkStartedDefer = new Deferred<void>();

export function registerMicroApps<T extends ObjectType>(
  apps: Array<RegistrableApp<T>>, // 需要注册的应用
  lifeCycles?: FrameworkLifeCycles<T>, // 对应的生命周期
) {
  // 过滤注册重复的应用
  const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));

  microApps = [...microApps, ...unregisteredApps];

  // 将需要注册的新应用，循环依次注册
  unregisteredApps.forEach((app) => {
    const { name, activeRule, loader = noop, props, ...appConfig } = app;

    // 实际还是调用 single-spa 的注册函数
    registerApplication({
      name,
      app: async () => {
        loader(true); // 设置 loading
        await frameworkStartedDefer.promise; // 等待 start 方法被调用

        const { mount, ...otherMicroAppConfigs } = (
          // 加载应用，获取生命周期钩子
          await loadApp({ name, props, ...appConfig }, frameworkConfiguration, lifeCycles)
        )();

        // 调用 mount 
        return {
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        };
      },
      activeWhen: activeRule,
      customProps: props,
    });
  });
}

const appConfigPromiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>();
const containerMicroAppsMap = new Map<string, MicroApp[]>();

export function loadMicroApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration,
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const { props, name } = app;

  const getContainerXpath = (container: string | HTMLElement): string | void => {
    const containerElement = getContainer(container);
    if (containerElement) {
      return getXPathForElement(containerElement, document);
    }

    return undefined;
  };

  let microApp: MicroApp;
  const wrapParcelConfigForRemount = (config: ParcelConfigObject): ParcelConfigObject => {
    const container = 'container' in app ? app.container : undefined;

    let microAppConfig = config;
    if (container) {
      const xpath = getContainerXpath(container);
      if (xpath) {
        const containerMicroApps = containerMicroAppsMap.get(`${name}-${xpath}`);
        if (containerMicroApps?.length) {
          const mount = [
            async () => {
              // While there are multiple micro apps mounted on the same container, we must wait until the prev instances all had unmounted
              // Otherwise it will lead some concurrent issues
              const prevLoadMicroApps = containerMicroApps.slice(0, containerMicroApps.indexOf(microApp));
              const prevLoadMicroAppsWhichNotBroken = prevLoadMicroApps.filter(
                (v) => v.getStatus() !== 'LOAD_ERROR' && v.getStatus() !== 'SKIP_BECAUSE_BROKEN',
              );
              await Promise.all(prevLoadMicroAppsWhichNotBroken.map((v) => v.unmountPromise));
            },
            ...toArray(microAppConfig.mount),
          ];

          microAppConfig = {
            ...config,
            mount,
          };
        }
      }
    }

    return {
      ...microAppConfig,
      // empty bootstrap hook which should not run twice while it calling from cached micro app
      bootstrap: () => Promise.resolve(),
    };
  };

  /**
   * using name + container xpath as the micro app instance id,
   * it means if you rendering a micro app to a dom which have been rendered before,
   * the micro app would not load and evaluate its lifecycles again
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const userConfiguration = configuration ?? { ...frameworkConfiguration, singular: false };
    const { $$cacheLifecycleByAppName } = userConfiguration;
    const container = 'container' in app ? app.container : undefined;

    if (container) {
      // using appName as cache for internal experimental scenario
      if ($$cacheLifecycleByAppName) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }

      const xpath = getContainerXpath(container);
      if (xpath) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(`${name}-${xpath}`);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }
    }

    const parcelConfigObjectGetterPromise = loadApp(app, userConfiguration, lifeCycles);

    if (container) {
      if ($$cacheLifecycleByAppName) {
        appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);
      } else {
        const xpath = getContainerXpath(container);
        if (xpath) appConfigPromiseGetterMap.set(`${name}-${xpath}`, parcelConfigObjectGetterPromise);
      }
    }

    return (await parcelConfigObjectGetterPromise)(container);
  };

  if (!started) {
    // We need to invoke start method of single-spa as the popstate event should be dispatched while the main app calling pushState/replaceState automatically,
    // but in single-spa it will check the start status before it dispatch popstate
    // see https://github.com/single-spa/single-spa/blob/f28b5963be1484583a072c8145ac0b5a28d91235/src/navigation/navigation-events.js#L101
    // ref https://github.com/umijs/qiankun/pull/1071
    startSingleSpa({ urlRerouteOnly: frameworkConfiguration.urlRerouteOnly ?? defaultUrlRerouteOnly });
  }

  microApp = mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });

  // Store the microApps which they mounted on the same container
  const container = 'container' in app ? app.container : undefined;
  if (container) {
    const xpath = getContainerXpath(container);
    if (xpath) {
      const key = `${name}-${xpath}`;

      const microAppsRef = containerMicroAppsMap.get(key) || [];
      microAppsRef.push(microApp);
      containerMicroAppsMap.set(key, microAppsRef);

      // gc after unmount
      microApp.unmountPromise.finally(() => {
        const index = microAppsRef.indexOf(microApp);
        microAppsRef.splice(index, 1);
        // @ts-ignore
        microApp = null;
      });
    }
  }

  return microApp;
}

export function start(opts: FrameworkConfiguration = {}) {
  // prefetch 是否支持预加载
  // singular 是否支持单例模式
  // sandbox 是否支持沙箱
  frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts };
  const {
    prefetch,
    sandbox,
    singular,
    urlRerouteOnly = defaultUrlRerouteOnly,
    ...importEntryOpts
  } = frameworkConfiguration;

  if (prefetch) { // 预加载策略
    doPrefetchStrategy(microApps, prefetch, importEntryOpts);
  }

  // 开启沙箱
  if (sandbox) {
    // 如果不支持 Proxy 则降级到快照沙箱 loose 表示使用快照沙箱
    if (!window.Proxy) {
      console.warn('[qiankun] Miss window.Proxy, proxySandbox will degenerate into snapshotSandbox');
      frameworkConfiguration.sandbox = typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true };
      // Proxy 下若为非单例模式 则会报错
      if (!singular) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        );
      }
    }
  }

  // 启动应用，最终实际调用 single spa 的 start 方法
  startSingleSpa({ urlRerouteOnly });
  started = true;

  // 启动后，将 promise 状态改为成功态
  frameworkStartedDefer.resolve();
}
