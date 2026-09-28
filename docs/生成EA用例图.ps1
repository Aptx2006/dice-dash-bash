param(
    [string]$ProjectPath = (Join-Path $PSScriptRoot '当骰一棒-用例图.eap'),
    [string]$ImagePath = (Join-Path $PSScriptRoot '当骰一棒-用例图.png')
)

$ErrorActionPreference = 'Stop'
$repository = New-Object -ComObject EA.Repository

try {
    if (-not (Test-Path -LiteralPath $ProjectPath)) {
        if (-not $repository.CreateModel(0, $ProjectPath, 0)) {
            throw "EA 无法创建工程：$ProjectPath"
        }
    }
    if (-not $repository.OpenFile($ProjectPath)) {
        throw "EA 无法打开工程：$ProjectPath"
    }

    $model = $repository.Models.GetAt(0)
    $package = $null
    for ($i = 0; $i -lt $model.Packages.Count; $i++) {
        $candidate = $model.Packages.GetAt($i)
        if ($candidate.Name -eq '当骰一棒·需求分析') { $package = $candidate; break }
    }
    if ($null -ne $package) {
        throw '工程中已有当骰一棒·需求分析模型；请在 EA 中修改现有图，避免重复生成。'
    }

    $package = $model.Packages.AddNew('当骰一棒·需求分析', '')
    if (-not $package.Update()) { throw "保存包失败：$($package.GetLastError())" }
    $model.Packages.Refresh()

    $diagram = $package.Diagrams.AddNew('当骰一棒——本地人机对局用例图', 'Use Case')
    $diagram.Notes = '实验2：当前本地原型的核心用户目标。房主也是玩家；智能体是系统内部机制，不画作外部Actor。真实联机、模型Agent、RAG不在本图中冒充已实现功能。'
    if (-not $diagram.Update()) { throw "保存图失败：$($diagram.GetLastError())" }
    $package.Diagrams.Refresh()

    function Add-ModelElement {
        param([string]$Name, [string]$Type, [string]$Notes, [int]$X, [int]$Y, [int]$W, [int]$H)
        $element = $package.Elements.AddNew($Name, $Type)
        $element.Notes = $Notes
        if (-not $element.Update()) { throw "保存元素失败：$Name；$($element.GetLastError())" }
        $package.Elements.Refresh()
        $geometry = "l=$X;r=$($X+$W);t=$Y;b=$($Y+$H);"
        $view = $diagram.DiagramObjects.AddNew($geometry, '')
        $view.ElementID = $element.ElementID
        if (-not $view.Update()) { throw "保存图元失败：$Name；$($view.GetLastError())" }
        $diagram.DiagramObjects.Refresh()
        return $element
    }

    # 系统边界先创建，让外部参与者与内部服务的范围一目了然。
    $boundary = Add-ModelElement '当骰一棒（本地人机对局）' 'Boundary' '边界内为游戏提供的用例，边界外为用户角色。' 190 35 1070 840
    $hostActor = Add-ModelElement '房主' 'Actor' '创建并配置本地房间；房主同时具有玩家权限。' 38 215 75 105
    $playerActor = Add-ModelElement '玩家' 'Actor' '完成回合、查看智能体行动与结算，可进入教学关。' 1340 340 75 105

    $cases = @{}
    $cases['room'] = Add-ModelElement 'UC-01 创建本地房间' 'UseCase' '输入昵称并创建本地房间；当前房间码不是远端联机连接。' 265 105 245 82
    $cases['configure'] = Add-ModelElement 'UC-02 配置地图与智能体' 'UseCase' '选择地图、角色并添加智能体补位。' 265 245 260 82
    $cases['start'] = Add-ModelElement 'UC-03 开始人机对局' 'UseCase' '在配置有效时进入棋盘，初始化回合与参与者状态。' 265 385 255 82
    $cases['tutorial'] = Add-ModelElement 'UC-04 体验教学关' 'UseCase' '通过教学关理解投骰、移动和基础操作。' 850 105 235 82
    $cases['turn'] = Add-ModelElement 'UC-05 完成玩家回合' 'UseCase' '完成投骰、移动以及可选的道具操作。' 850 245 240 82
    $cases['move'] = Add-ModelElement 'UC-06 投骰并移动' 'UseCase' '显示骰值和合法位置，确认后更新棋盘。' 575 245 235 82
    $cases['tool'] = Add-ModelElement 'UC-07 使用道具' 'UseCase' '在允许阶段选择道具与合法目标；没有目标时不消耗道具。' 655 405 240 82
    $cases['watch'] = Add-ModelElement 'UC-08 观察智能体行动' 'UseCase' '展示智能体出牌、骰值、移动路径与可调动画速度。' 850 560 250 82
    $cases['result'] = Add-ModelElement 'UC-09 查看对局结算' 'UseCase' '到达终点后展示结果并结束当前对局。' 850 710 240 82

    function Add-ModelConnector {
        param($From, $To, [string]$Type, [string]$Label = '')
        $eaType = if ($Type -in @('Include', 'Extend')) { 'Dependency' } else { $Type }
        $connector = $From.Connectors.AddNew($Label, $eaType)
        $connector.SupplierID = $To.ElementID
        if ($Type -in @('Include', 'Extend')) { $connector.Stereotype = $Type.ToLowerInvariant() }
        if (-not $connector.Update()) { throw "保存关系失败：$($From.Name) → $($To.Name)；$($connector.GetLastError())" }
        $From.Connectors.Refresh()
    }

    Add-ModelConnector $hostActor $cases['room'] 'Association'
    Add-ModelConnector $hostActor $cases['configure'] 'Association'
    Add-ModelConnector $hostActor $cases['start'] 'Association'
    Add-ModelConnector $playerActor $cases['tutorial'] 'Association'
    Add-ModelConnector $playerActor $cases['turn'] 'Association'
    Add-ModelConnector $playerActor $cases['watch'] 'Association'
    Add-ModelConnector $playerActor $cases['result'] 'Association'
    Add-ModelConnector $cases['turn'] $cases['move'] 'Include'
    Add-ModelConnector $cases['tool'] $cases['turn'] 'Extend'

    if (-not $diagram.Update()) { throw "更新图失败：$($diagram.GetLastError())" }
    $repository.ReloadDiagram($diagram.DiagramID)
    $project = $repository.GetProjectInterface()
    $guid = $project.GUIDtoXML($diagram.DiagramGUID)
    $exported = $project.PutDiagramImageToFile($guid, $ImagePath, 1)
    Write-Output "EAP=$ProjectPath"
    Write-Output "DIAGRAM=$($diagram.Name)"
    Write-Output "GUID=$($diagram.DiagramGUID)"
    Write-Output "ELEMENTS=$($diagram.DiagramObjects.Count)"
    Write-Output "IMAGE=$ImagePath"
    Write-Output "EXPORTED=$exported"
}
finally {
    if ($null -ne $repository) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($repository)
    }
}
