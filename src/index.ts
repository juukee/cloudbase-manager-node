import { EnvironmentManager } from './environmentManager'
import { Environment } from './environment'
import { getRuntime, getEnvVar } from './utils'
import { RUN_ENV, ENV_NAME, ERROR } from './constant'
import { FunctionService } from './function'
import { StorageService } from './storage'
import { DatabaseService } from './database'
import { EnvService } from './env'
import { CloudBaseContext } from './context'
import { CommonService } from './common'

interface CloudBaseConfig {
    secretId?: string
    secretKey?: string
    token?: string
    envId?: string
    proxy?: string
}

class CloudBase {
    private static cloudBase: CloudBase

    /**
     * init 初始化 为单例
     *
     * @static
     * @param {ManagerConfig} config
     * @returns {CloudBase}
     * @memberof CloudBase
     */
    public static init(config: CloudBaseConfig): CloudBase {
        if (!CloudBase.cloudBase) {
            CloudBase.cloudBase = new CloudBase(config)
        }

        return CloudBase.cloudBase
    }

    private context: CloudBaseContext
    private cloudBaseConfig: CloudBaseConfig = {}
    private environmentManager: EnvironmentManager

    public constructor(config: CloudBaseConfig = {}) {
        let { secretId, secretKey, token, envId, proxy } = config
        // config 中传入的 secretid secretkey 必须同时存在
        if ((secretId && !secretKey) || (!secretId && secretKey)) {
            throw new Error('secretId and secretKey must be a pair')
        }

        this.cloudBaseConfig = {
            secretId,
            secretKey,
            token,
            envId,
            proxy
        }

        // 初始化 context
        this.context = new CloudBaseContext(this.cloudBaseConfig)

        this.environmentManager = new EnvironmentManager(this.context)
        this.environmentManager.add(envId || '')
    }

    public addEnvironment(envId: string): void {
        this.environmentManager.add(envId)
    }

    public currentEnvironment(): Environment {
        return this.environmentManager.getCurrentEnv()
    }

    public get functions(): FunctionService {
        return this.currentEnvironment().getFunctionService()
    }
    public get storage(): StorageService {
        return this.currentEnvironment().getStorageService()
    }
    public get database(): DatabaseService {
        return this.currentEnvironment().getDatabaseService()
    }

    public commonService(service?: string, version?: string): CommonService {
        return this.currentEnvironment().getCommonService(service, version)
    }

    public get env(): EnvService {
        return this.currentEnvironment().getEnvService()
    }

    public getEnvironmentManager(): EnvironmentManager {
        return this.environmentManager
    }

    public getManagerConfig(): CloudBaseConfig {
        return this.cloudBaseConfig
    }
}

export = CloudBase
