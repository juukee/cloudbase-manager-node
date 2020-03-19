import CloudBase from './index'
import { cloudBaseConfig } from '../test/config'

const app = new CloudBase(cloudBaseConfig)
// const app = new CloudBase({})

async function test() {
    const res = await app.functions.createFunction({
        func: {
            // functions 文件夹下函数文件夹的名称，即函数名
            name: 'big',
            timeout: 5,
            // 环境变量
            envVariables: {},
            // 运行时
            runtime: 'Nodejs8.9',
            // 安装依赖
            installDependency: false,
            ignore: []
        },
        functionRootPath: './test/functions/',
        force: true
    })
}
test()
