import { FunctionPacker, CodeType } from './packer'
import { Environment } from '../environment'
import {
    IResponseInfo,
    ICloudFunction,
    IFunctionLogOptions,
    ICloudFunctionTrigger,
    IFunctionInvokeRes,
    IFunctionLogRes,
    IFunctionDownloadUrlRes
} from '../interfaces'
import { CloudBaseError } from '../error'
import { CloudService, preLazy, sleep, zipDir } from '../utils'
import { SCF_STATUS } from '../constant'
import { isDirectory, checkPathExist, delSync } from '../utils/fs'
import path from 'path'
import fs from 'fs'

export interface ICreateFunctionParam {
    func: ICloudFunction // 云函数信息
    functionRootPath: string // 云函数根目录
    force: boolean // 是否覆盖同名云函数
    base64Code: string
    codeSecret?: string // 代码保护密钥
}

export interface IUpdateFunctionCodeParam {
    func: ICloudFunction // 云函数信息
    functionRootPath?: string // 云函数的目录路径（可选） functionRootPath 与 base64Code 可任选其中一个
    base64Code?: string // 云函数 ZIP 文件的 base64 编码（可选）
    codeSecret?: string // 代码保护密钥
}

export interface IUpdateFunctionIncrementalCodeParam {
    func: ICloudFunction
    functionRootPath: string // 必选
    deleteFiles?: Array<string> // 要删除的文件和目录列表
    addFiles?: string // 新增或修改的文件路径 （指定单个文件或单个文件夹）
}

export interface ICreateFunctionRes {
    triggerRes: IResponseInfo
    configRes: IResponseInfo
    codeRes: IResponseInfo
}

export interface IFunctionLayerOptions {
    contentPath?: string
    base64Content?: string
    name: string
    runtimes: string[] // 支持的运行时
    description?: string // 层版本描述
    licenseInfo?: string // 层的软件许可证
}

export interface ICreateLayerResponse extends IResponseInfo {
    LayerVersion: number
}

export interface ILayerOptions {
    name: string
    version: number
}

export interface IVersionListOptions {
    name: string
    runtimes?: string[]
}

export interface ILayerListOptions {
    offset?: number
    limit?: number
    runtime?: string
    searchKey?: string
}

export interface ILayerVersionInfo {
    CompatibleRuntimes: string[] // 版本适用的运行时
    AddTime: string // 创建时间
    Description: string // 版本描述
    LicenseInfo: string // 许可证信息
    LayerVersion: number // 版本号
    LayerName: string // 层名称
    Status: string // 层的具体版本当前状态
}

export interface IListLayerVersionsRes extends IResponseInfo {
    LayerVersions: Array<ILayerVersionInfo>
}

export interface IListLayerRes extends IResponseInfo {
    Layers: Array<ILayerVersionInfo>
    TotalCount: number
}

export interface IGetLayerVersionRes extends IResponseInfo {
    CompatibleRuntimes: string[] // 适配的运行时
    CodeSha256: string // 层中版本文件的SHA256编码
    Location: string // 层中版本文件的下载地址
    AddTime: string // 版本的创建时间
    Description: string // 版本的描述
    LicenseInfo: string // 许可证信息
    LayerVersion: number // 版本号
    LayerName: string // 层名称
    Status: string // 	层的具体版本当前状态
}

// 校验函数参数
function validCreateParams(func: ICloudFunction, codeSecret?: string) {
    // 校验 CodeSecret 格式
    if (codeSecret && !/^[A-Za-z0-9+=/]{1,160}$/.test(codeSecret)) {
        throw new CloudBaseError(
            'CodeSecret 格式错误，CodeSecret 只能包含 1-160 位大小字母、数字、"+"、"="、"/"'
        )
    }

    // 校验运行时
    const validRuntime = ['Nodejs8.9', 'Php7', 'Java8']
    if (func?.runtime && !validRuntime.includes(func.runtime)) {
        throw new CloudBaseError(
            `${func.name} Invalid runtime value：${
                func.runtime
            }. Now only support: ${validRuntime.join(', ')}`
        )
    }
}

export class FunctionService {
    private environment: Environment
    private vpcService: CloudService
    private scfService: CloudService

    private tcbRole: any = {
        Role: 'TCB_QcsRole',
        Stamp: 'MINI_QCBASE'
    }

    constructor(environment: Environment) {
        this.environment = environment
        this.scfService = new CloudService(environment.cloudBaseContext, 'scf', '2018-04-16')
        this.vpcService = new CloudService(environment.cloudBaseContext, 'vpc', '2017-03-12')
    }

    /**
     * 增量更新函数代码
     * @param {IUpdateFunctionIncrementalCodeParam} funcParam
     * @returns {Promise<void>}
     * @memberof FunctionService
     */
    @preLazy()
    public async updateFunctionIncrementalCode(
        funcParam: IUpdateFunctionIncrementalCodeParam
    ): Promise<IResponseInfo> {
        const { namespace } = this.getFunctionConfig()
        const { functionRootPath, func, deleteFiles, addFiles } = funcParam
        const { name, runtime } = func
        const params: any = {
            FunctionName: name,
            Namespace: namespace
        }

        let packer: FunctionPacker
        let base64

        validCreateParams(func)

        if (deleteFiles) {
            params.DeleteFiles = deleteFiles
        }

        if (addFiles) {
            // 将选中的增量文件或增量文件夹  转base64
            packer = new FunctionPacker(functionRootPath, name, [], addFiles)
            const type: CodeType = func.runtime === 'Java8' ? CodeType.JavaFile : CodeType.File
            base64 = await packer.build(type)
            if (!base64) {
                throw new CloudBaseError('函数不存在！')
            }

            params.AddFiles = base64
        }

        const res = await this.scfService.request('UpdateFunctionIncrementalCode', params)
        return res
    }

    /**
     * 创建云函数
     * @param {ICreateFunctionParam} funcParam
     * @returns {(Promise<IResponseInfo | ICreateFunctionRes>)}
     */
    @preLazy()
    public async createFunction(
        funcParam: ICreateFunctionParam
    ): Promise<IResponseInfo | ICreateFunctionRes> {
        // TODO: 优化处理逻辑
        const { namespace } = this.getFunctionConfig()
        const { func, functionRootPath, force = false, base64Code, codeSecret } = funcParam
        let base64
        let packer: FunctionPacker
        const funcName = func.name

        validCreateParams(func, codeSecret)

        let installDependency
        // Node 8.9 默认安装依赖
        installDependency = func.runtime === 'Nodejs8.9' ? 'TRUE' : 'FALSE'
        // 是否安装依赖，选项可以覆盖
        if (typeof func.installDependency !== 'undefined') {
            installDependency = func.installDependency ? 'TRUE' : 'FALSE'
        }

        // CLI 从本地读取
        if (!base64Code) {
            // 云端安装依赖，自动忽略 node_modules 目录
            const ignore =
                installDependency === 'TRUE'
                    ? ['node_modules/**/*', 'node_modules', ...(func.ignore || [])]
                    : [...(func.ignore || [])]
            packer = new FunctionPacker(functionRootPath, funcName, ignore)
            const type: CodeType = func.runtime === 'Java8' ? CodeType.JavaFile : CodeType.File
            base64 = await packer.build(type)

            if (!base64) {
                throw new CloudBaseError('函数不存在！')
            }
        } else {
            base64 = base64Code
        }

        // 转换环境变量
        const envVariables = Object.keys(func.envVariables || {}).map(key => ({
            Key: key,
            Value: func.envVariables[key]
        }))

        // 当不存在 L5 配置时，不修改 L5 状态，否则根据 true/false 进行修改
        const l5Enable = typeof func?.l5 === 'undefined' ? null : func?.l5 ? 'TRUE' : 'FALSE'

        const params: any = {
            FunctionName: funcName,
            Namespace: namespace,
            Code: {
                ZipFile: base64
            },
            // 不可选择
            MemorySize: 256,
            Role: 'TCB_QcsRole',
            Stamp: 'MINI_QCBASE',
            L5Enable: l5Enable
        }

        // 修复参数存在 undefined 字段时，会出现鉴权失败的情况
        // Environment 为覆盖式修改，不保留已有字段
        envVariables.length && (params.Environment = { Variables: envVariables })
        // 处理入口
        params.Handler = func.handler || 'index.main'
        // 默认超时时间为 20S
        params.Timeout = Number(func.timeout) || 20
        // 默认运行环境 Nodejs8.9
        params.Runtime = func.runtime || 'Nodejs8.9'
        // VPC 网络
        params.VpcConfig = {
            SubnetId: (func.vpc && func.vpc.subnetId) || '',
            VpcId: (func.vpc && func.vpc.vpcId) || ''
        }
        // 自动安装依赖
        params.InstallDependency = installDependency

        // 代码保护
        if (codeSecret) {
            params.CodeSecret = codeSecret
        }

        // 当使用 VPC 网络时，开启 EIP 配置
        if (params.VpcConfig.SubnetId && params.VpcConfig.VpcId) {
            params.EipConfig = { EipFixed: 'TRUE' }
        } else {
            params.EipConfig = { EipFixed: 'FALSE' }
        }

        // 函数层
        func.layers && func.layers.length && (params.Layers = func.layers)

        try {
            // 创建云函数
            const res = await this.scfService.request('CreateFunction', params)
            // 创建函数触发器、失败自动重试
            await this.retryCreateTrigger(funcName, func.triggers)
            // await this.createFunctionTriggers(funcName, func.triggers)

            // 如果选择自动安装依赖，且等待依赖安装
            if (params.InstallDependency && func.isWaitInstall === true) {
                await this.waitFunctionActive(funcName)
            }
            return res
        } catch (e) {
            // 已存在同名函数，强制更新
            if (e.code === 'ResourceInUse.FunctionName' && force) {
                // 创建函数触发器
                const triggerRes = await this.createFunctionTriggers(funcName, func.triggers)
                // 更新函数配置和代码
                const configRes = await this.updateFunctionConfig(func)
                // 更新函数代码
                const codeRes = await this.retryUpdateFunctionCode({
                    func,
                    functionRootPath,
                    base64Code: base64,
                    codeSecret: codeSecret
                })
                // 返回全部操作的响应值
                return {
                    triggerRes,
                    configRes,
                    codeRes
                }
            }

            // 不强制覆盖，抛出错误
            if (e.message && !force) {
                throw new CloudBaseError(`[${funcName}] 部署失败：\n${e.message}`, {
                    code: e.code,
                    requestId: e.requestId
                })
            }

            throw e
        }
    }

    /**
     * 列出函数
     * @param {number} [limit=20]
     * @param {number} [offset=0]
     * @returns {Promise<Record<string, string>[]>}
     */
    @preLazy()
    async listFunctions(limit = 20, offset = 0): Promise<Record<string, string>[]> {
        // 获取Function 环境配置
        const { namespace } = this.getFunctionConfig()

        const res: any = await this.scfService.request('ListFunctions', {
            Namespace: namespace,
            Limit: limit,
            Offset: offset
        })
        const { Functions = [] } = res
        const data: Record<string, string>[] = []
        Functions.forEach(func => {
            const { FunctionId, FunctionName, Runtime, AddTime, ModTime, Status } = func
            data.push({
                FunctionId,
                FunctionName,
                Runtime,
                AddTime,
                ModTime,
                Status
            })
        })

        return data
    }

    /**
     * 删除云函数
     * @param {string} name 云函数名称
     * @returns {Promise<IResponseInfo>}
     */
    @preLazy()
    async deleteFunction(name: string): Promise<IResponseInfo> {
        const { namespace } = this.getFunctionConfig()
        return this.scfService.request('DeleteFunction', {
            FunctionName: name,
            Namespace: namespace
        })
    }

    /**
     * 获取云函数详细信息
     * @param {string} name 云函数名称
     * @returns {Promise<Record<string, string>>}
     */
    @preLazy()
    async getFunctionDetail(name: string, codeSecret?: string): Promise<Record<string, string>> {
        const { namespace } = this.getFunctionConfig()

        const params: any = {
            FunctionName: name,
            Namespace: namespace,
            ShowCode: 'TRUE'
        }

        if (codeSecret) {
            params.CodeSecret = codeSecret
        }

        const res = await this.scfService.request('GetFunction', params)

        const data: Record<string, any> = {}
        // 提取信息的键
        const validKeys = [
            'Status',
            'CodeInfo',
            'CodeSize',
            'Environment',
            'FunctionName',
            'Handler',
            'MemorySize',
            'ModTime',
            'Namespace',
            'Runtime',
            'Timeout',
            'Triggers',
            'VpcConfig'
        ]

        // 响应字段为 Duration 首字母大写形式，将字段转换成驼峰命名
        Object.keys(res).forEach(key => {
            if (!validKeys.includes(key)) return
            data[key] = res[key]
        })

        const { VpcId = '', SubnetId = '' } = data.VpcConfig || {}

        if (VpcId && SubnetId) {
            try {
                const vpcs = await this.getVpcs()
                const subnets = await this.getSubnets(VpcId)
                const vpc = vpcs.find(item => item.VpcId === VpcId)
                const subnet = subnets.find(item => item.SubnetId === SubnetId)
                data.VpcConfig = {
                    vpc,
                    subnet
                }
            } catch (e) {
                data.VPC = {
                    vpc: '',
                    subnet: ''
                }
            }
        }

        return data
    }

    /**
     * 获取函数日志
     * @param {{
     *         name: string
     *         offset: number
     *         limit: number
     *         order: string
     *         orderBy: string
     *         startTime: string
     *         endTime: string
     *         requestId: string
     *     }} options
     * @returns {Promise<IFunctionLogRes>}
     */
    @preLazy()
    async getFunctionLogs(options: IFunctionLogOptions): Promise<IFunctionLogRes> {
        const {
            name,
            offset = 0,
            limit = 10,
            order,
            orderBy,
            startTime,
            endTime,
            requestId
        } = options
        const { namespace } = this.getFunctionConfig()

        const params = {
            Namespace: namespace,
            FunctionName: name,
            Offset: offset,
            Limit: limit,
            Order: order,
            OrderBy: orderBy,
            StartTime: startTime,
            EndTime: endTime,
            FunctionRequestId: requestId
        }

        const res: IFunctionLogRes = await this.scfService.request('GetFunctionLogs', params)
        return res
    }

    /**
     * 更新云函数配置
     * @param {ICloudFunction} func 云函数配置
     * @returns {Promise<IResponseInfo>}
     */
    @preLazy()
    async updateFunctionConfig(func: ICloudFunction): Promise<IResponseInfo> {
        const { namespace } = this.getFunctionConfig()

        const envVariables = Object.keys(func.envVariables || {}).map(key => ({
            Key: key,
            Value: func.envVariables[key]
        }))

        // 当不存在 L5 配置时，不修改 L5 状态，否则根据 true/false 进行修改
        const l5Enable = typeof func.l5 === 'undefined' ? null : func.l5 ? 'TRUE' : 'FALSE'

        const params: any = {
            FunctionName: func.name,
            Namespace: namespace,
            L5Enable: l5Enable
        }

        // 修复参数存在 undefined 字段时，会出现鉴权失败的情况
        // Environment 为覆盖式修改，不保留已有字段
        envVariables.length && (params.Environment = { Variables: envVariables })
        // 不设默认超时时间，防止覆盖已有配置
        func.timeout && (params.Timeout = func.timeout)
        // 运行时
        func.runtime && (params.Runtime = func.runtime)
        // VPC 网络
        params.VpcConfig = {
            SubnetId: (func.vpc && func.vpc.subnetId) || '',
            VpcId: (func.vpc && func.vpc.vpcId) || ''
        }

        // Node 8.9 默认安装依赖
        func.runtime === 'Nodejs8.9' && (params.InstallDependency = 'TRUE')
        // 是否安装依赖，选项可以覆盖
        if (typeof func.installDependency !== 'undefined') {
            params.InstallDependency = func.installDependency ? 'TRUE' : 'FALSE'
        }

        // 函数层
        func.layers && func.layers.length && (params.Layers = func.layers)

        return this.scfService.request('UpdateFunctionConfiguration', params)
    }

    /**
     *
     * @param {IUpdateFunctionCodeParam} funcParam
     * @returns {Promise<IResponseInfo>}
     * @memberof FunctionService
     */
    @preLazy()
    async updateFunctionCode(funcParam: IUpdateFunctionCodeParam): Promise<IResponseInfo> {
        let base64
        let packer
        const { func, functionRootPath, base64Code, codeSecret } = funcParam
        const funcName = func.name

        const { namespace } = this.getFunctionConfig()

        validCreateParams(func)

        let installDependency
        // Node 8.9 默认安装依赖
        installDependency = func.runtime === 'Nodejs8.9' ? 'TRUE' : 'FALSE'
        // 是否安装依赖，选项可以覆盖
        if (typeof func.installDependency !== 'undefined') {
            installDependency = func.installDependency ? 'TRUE' : 'FALSE'
        }

        // CLI 从本地读取
        if (!base64Code) {
            const ignore =
                installDependency === 'TRUE'
                    ? ['node_modules/**/*', 'node_modules', ...(func.ignore || [])]
                    : [...(func.ignore || [])]
            packer = new FunctionPacker(functionRootPath, funcName, ignore)
            const type: CodeType = func.runtime === 'Java8' ? CodeType.JavaFile : CodeType.File
            base64 = await packer.build(type)

            if (!base64) {
                throw new CloudBaseError('函数不存在！')
            }
        } else {
            base64 = base64Code
        }

        const params: any = {
            FunctionName: funcName,
            Namespace: namespace,
            ZipFile: base64,
            Handler: func.handler || 'index.main',
            InstallDependency: installDependency
        }

        if (codeSecret) {
            params.CodeSecret = codeSecret
        }

        try {
            // 更新云函数代码
            const res = await this.scfService.request('UpdateFunctionCode', params)
            if (installDependency && func.isWaitInstall === true) {
                await this.waitFunctionActive(funcName)
            }
            return res
        } catch (e) {
            throw new CloudBaseError(`[${funcName}] 函数代码更新失败： ${e.message}`, {
                code: e.code
            })
        }
    }

    /**
     * 调用云函数
     * @param {string} name 云函数名称
     * @param {Record<string, any>} params 调用函数传入参数
     * @returns {Promise<IFunctionInvokeRes>}
     */
    @preLazy()
    async invokeFunction(name: string, params?: Record<string, any>): Promise<IFunctionInvokeRes> {
        const { namespace } = this.getFunctionConfig()

        const _params: any = {
            FunctionName: name,
            Namespace: namespace,
            LogType: 'Tail'
        }

        if (params) {
            _params.ClientContext = JSON.stringify(params)
        }

        try {
            const { RequestId, Result } = await this.scfService.request('Invoke', _params)
            return {
                RequestId,
                ...Result
            }
        } catch (e) {
            throw new CloudBaseError(`[${name}] 调用失败：\n${e.message}`)
        }
    }

    /**
     * 复制云函数
     * @param {string} name 云函数名称
     * @param {string} newFunctionName 新的云函数名称
     * @param {string} targetEnvId 目标环境 Id
     * @param {boolean} [force=false] 是否覆盖同名云函数
     * @returns {Promise<IResponseInfo>}
     */
    /* eslint-disable-next-line */
    @preLazy()
    async copyFunction(
        name: string,
        newFunctionName: string,
        targetEnvId?: string,
        force = false
    ): Promise<IResponseInfo> {
        const { namespace } = this.getFunctionConfig()

        if (!namespace || !name || !newFunctionName) {
            throw new CloudBaseError('参数缺失')
        }

        return this.scfService.request('CopyFunction', {
            FunctionName: name,
            NewFunctionName: newFunctionName,
            Namespace: namespace,
            TargetNamespace: targetEnvId || namespace,
            Override: force ? true : false
        })
    }

    /**
     * 创建云函数触发器
     * @param {string} name 云函数名称
     * @param {ICloudFunctionTrigger[]} triggers 云函数触发器配置
     * @returns {Promise<IResponseInfo>}
     */
    @preLazy()
    async createFunctionTriggers(
        name: string,
        triggers: ICloudFunctionTrigger[] = []
    ): Promise<IResponseInfo> {
        if (!triggers || !triggers.length) return null
        const { namespace } = this.getFunctionConfig()

        const parsedTriggers = triggers.map(item => {
            if (item.type !== 'timer') {
                throw new CloudBaseError(
                    `不支持的触发器类型 [${item.type}]，目前仅支持定时触发器（timer）！`
                )
            }
            return {
                TriggerName: item.name,
                Type: item.type,
                TriggerDesc: item.config
            }
        })

        return this.scfService.request('BatchCreateTrigger', {
            FunctionName: name,
            Namespace: namespace,
            Triggers: JSON.stringify(parsedTriggers),
            Count: parsedTriggers.length
        })
    }

    /**
     * 删除云函数触发器
     * @param {string} name 云函数名称
     * @param {string} triggerName 云函数触发器名称
     * @returns {Promise<IResponseInfo>}
     */
    @preLazy()
    async deleteFunctionTrigger(name: string, triggerName: string): Promise<IResponseInfo> {
        const { namespace } = this.getFunctionConfig()

        return this.scfService.request('DeleteTrigger', {
            FunctionName: name,
            Namespace: namespace,
            TriggerName: triggerName,
            Type: 'timer'
        })
    }

    /**
     * 获取云函数代码下载 链接
     * @param {string} functionName
     * @param {string} [codeSecret]
     * @returns {Promise<IFunctionDownloadUrlRes>}
     * @memberof FunctionService
     */
    @preLazy()
    public async getFunctionDownloadUrl(
        functionName: string,
        codeSecret?: string
    ): Promise<IFunctionDownloadUrlRes> {
        const { namespace } = this.getFunctionConfig()

        const params: any = {
            FunctionName: functionName,
            Namespace: namespace
        }

        if (codeSecret) {
            params.CodeSecret = codeSecret
        }

        try {
            const { Url, CodeSha256, RequestId } = await this.scfService.request(
                'GetFunctionAddress',
                params
            )
            return { Url, RequestId, CodeSha256 }
        } catch (e) {
            throw new CloudBaseError(`[${functionName}] 获取函数代码下载链接失败：\n${e.message}`)
        }
    }

    // 创建文件层版本
    public async createLayer(options: IFunctionLayerOptions): Promise<ICreateLayerResponse> {
        const {
            contentPath = '',
            name,
            base64Content = '',
            runtimes = [],
            description = '',
            licenseInfo = ''
        } = options

        // checkFullAccess(contentPath)

        const validRuntime = ['Nodejs8.9', 'Php7', 'Java8']
        if (runtimes.some(item => validRuntime.indexOf(item) === -1)) {
            throw new CloudBaseError(
                `Invalid runtime value. Now only support: ${validRuntime.join(', ')}`
            )
        }

        let base64

        if (base64Content) {
            base64 = base64Content
        } else if (isDirectory(contentPath)) {
            // 压缩文件夹
            const dirName = path.parse(contentPath).name
            const dest = path.join(process.cwd(), `temp-${dirName}.zip`)
            // ZIP 文件存在，删除 ZIP 文件
            if (checkPathExist(dest)) {
                delSync(dest)
            }
            await zipDir({
                dirPath: contentPath,
                outputPath: dest
            })
            // 转换成 base64
            const fileBuffer = await fs.promises.readFile(dest)
            base64 = fileBuffer.toString('base64')
            delSync(dest)
        } else {
            const fileType = path.extname(contentPath)
            if (fileType !== '.zip') {
                throw new CloudBaseError('文件类型不正确，目前只支持 ZIP 文件！')
            }
            const fileBuffer = await fs.promises.readFile(contentPath)
            base64 = fileBuffer.toString('base64')
        }

        return this.scfService.request('PublishLayerVersion', {
            LayerName: name,
            CompatibleRuntimes: runtimes,
            Content: {
                // 最大支持 20M
                ZipFile: base64
            },
            Description: description,
            LicenseInfo: licenseInfo
        })
    }

    // 删除文件层版本
    public async deleteLayerVersion(options: ILayerOptions): Promise<IResponseInfo> {
        const { name, version } = options

        return this.scfService.request('DeleteLayerVersion', {
            LayerName: name,
            LayerVersion: version
        })
    }

    // 获取层版本列表
    public async listLayerVersions(options: IVersionListOptions): Promise<IListLayerVersionsRes> {
        const { name, runtimes } = options
        let param: any = {
            LayerName: name
        }
        if (runtimes?.length) {
            const validRuntime = ['Nodejs8.9', 'Php7', 'Java8']
            if (runtimes.some(item => validRuntime.indexOf(item) === -1)) {
                throw new CloudBaseError(
                    `Invalid runtime value. Now only support: ${validRuntime.join(', ')}`
                )
            }
            param.CompatibleRuntime = runtimes
        }
        return this.scfService.request('ListLayerVersions', param)
    }

    // 获取文件层列表
    public async listLayers(options: ILayerListOptions): Promise<IListLayerRes> {
        const { limit = 20, offset = 0, runtime, searchKey } = options
        let param: any = {
            Limit: limit,
            Offset: offset,
            SearchKey: searchKey
        }
        if (runtime) {
            const validRuntime = ['Nodejs8.9', 'Php7', 'Java8']
            if (validRuntime.indexOf(runtime) === -1) {
                throw new CloudBaseError(
                    `Invalid runtime value. Now only support: ${validRuntime.join(', ')}`
                )
            }
            param.CompatibleRuntime = runtime
        }

        return this.scfService.request('ListLayers', param)
    }

    // 获取层版本详细信息
    public async getLayerVersion(options: ILayerOptions): Promise<IGetLayerVersionRes> {
        const { name, version } = options

        return this.scfService.request('GetLayerVersion', {
            LayerName: name,
            LayerVersion: version
        })
    }

    private async retryCreateTrigger(name, triggers, count = 0) {
        try {
            await this.createFunctionTriggers(name, triggers)
        } catch (e) {
            if (count < 3) {
                await sleep(500)
                await this.retryCreateTrigger(name, triggers, count + 1)
            } else {
                throw e
            }
        }
    }

    private async retryUpdateFunctionCode(param, count = 0) {
        try {
            return await this.updateFunctionCode(param)
        } catch (e) {
            if (count < 3) {
                await sleep(500)
                return await this.retryUpdateFunctionCode(param, count + 1)
            } else {
                throw e
            }
        }
    }

    /**
     *
     * @private
     * @returns
     * @memberof FunctionService
     */
    private getFunctionConfig() {
        const envConfig = this.environment.lazyEnvironmentConfig
        const namespace = envConfig.Functions[0].Namespace

        return {
            namespace,
            env: envConfig.EnvId
        }
    }

    /**
     * 获取 vpc 信息
     * @returns
     */
    private async getVpcs() {
        const { VpcSet } = await this.vpcService.request('DescribeVpcs')
        return VpcSet
    }

    /**
     * 获取子网
     * @param {string} vpcId
     * @returns
     */
    private async getSubnets(vpcId: string) {
        const { SubnetSet } = await this.vpcService.request('DescribeSubnets', {
            Filters: [
                {
                    Name: 'vpc-id',
                    Values: [vpcId]
                }
            ]
        })
        return SubnetSet
    }

    private async waitFunctionActive(funcName: string) {
        // 检查函数状态
        let status
        do {
            const { Status } = await this.getFunctionDetail(funcName)
            await sleep(1000)
            status = Status
        } while (status === SCF_STATUS.CREATING || status === SCF_STATUS.UPDATING)
    }
}
